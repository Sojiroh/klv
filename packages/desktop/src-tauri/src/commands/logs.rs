use std::sync::Arc;

use futures::AsyncBufReadExt;
use futures::TryStreamExt;
use serde::Deserialize;
use tauri::{command, AppHandle, Emitter, State};

use crate::error::KlvError;
use crate::parser::log_parser::{parse_log_line, ParsedLog};
use crate::parser::log_filter::{matches_filter, LogFilter};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQueryParams {
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
    pub tail: Option<i64>,
    pub since: Option<i64>,
    pub level: Option<String>,
    pub search: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStartPayload {
    pub namespace: String,
    pub pods: Vec<String>,
    pub container: Option<String>,
    pub filters: Option<StreamFilters>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamFilters {
    pub level: Option<String>,
    pub search: Option<String>,
    pub exclude_patterns: Option<Vec<String>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsResponse {
    pub logs: Vec<ParsedLog>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[command]
pub async fn get_pod_logs(
    state: State<'_, Arc<AppState>>,
    params: LogQueryParams,
) -> Result<LogsResponse, KlvError> {
    let client = state.get_client().await?;

    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{Api, LogParams};

    let pods_api: Api<Pod> = Api::namespaced(client, &params.namespace);

    let mut lp = LogParams::default();
    lp.tail_lines = Some(params.tail.unwrap_or(100));
    lp.since_seconds = params.since;
    lp.timestamps = true;
    lp.container = params.container.clone();

    let raw = pods_api.logs(&params.pod, &lp).await.map_err(|e| {
        KlvError::new(format!("Error al obtener logs del pod \"{}\": {e}", params.pod))
    })?;

    let filter = build_filter(&params.level, &params.search, &None);

    let mut parsed: Vec<ParsedLog> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| parse_log_line(l, Some(&params.pod)))
        .filter(|log| matches_filter(log, &filter))
        .collect();

    let total = parsed.len();
    let offset = params.offset.unwrap_or(0);
    let limit = params.limit.unwrap_or(500).min(10000);

    parsed = parsed.into_iter().skip(offset).take(limit).collect();

    Ok(LogsResponse {
        logs: parsed,
        total,
        offset,
        limit,
    })
}

#[command]
pub async fn get_container_logs(
    state: State<'_, Arc<AppState>>,
    namespace: String,
    container: String,
    tail: Option<i64>,
    since: Option<i64>,
    level: Option<String>,
    search: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<LogsResponse, KlvError> {
    let client = state.get_client().await?;

    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{Api, ListParams, LogParams};

    let pods_api: Api<Pod> = Api::namespaced(client, &namespace);
    let list = pods_api.list(&ListParams::default()).await.map_err(|e| {
        KlvError::new(format!("Error al obtener pods: {e}"))
    })?;

    let matching_pods: Vec<String> = list
        .items
        .iter()
        .filter(|pod| {
            pod.spec
                .as_ref()
                .map(|s| s.containers.iter().any(|c| c.name == container))
                .unwrap_or(false)
        })
        .filter_map(|pod| pod.metadata.name.clone())
        .collect();

    let filter = build_filter(&level, &search, &None);
    let mut all_logs: Vec<ParsedLog> = Vec::new();

    for pod_name in &matching_pods {
        let mut lp = LogParams::default();
        lp.tail_lines = Some(tail.unwrap_or(100));
        lp.since_seconds = since;
        lp.timestamps = true;
        lp.container = Some(container.clone());

        match pods_api.logs(pod_name, &lp).await {
            Ok(raw) => {
                let logs: Vec<ParsedLog> = raw
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| parse_log_line(l, Some(pod_name)))
                    .filter(|log| matches_filter(log, &filter))
                    .collect();
                all_logs.extend(logs);
            }
            Err(_) => {
                // Skip pods that fail to return logs (same as TS behavior)
            }
        }
    }

    all_logs.sort_by(|a, b| {
        let ta = a.timestamp.as_deref().unwrap_or("");
        let tb = b.timestamp.as_deref().unwrap_or("");
        ta.cmp(tb)
    });

    let total = all_logs.len();
    let off = offset.unwrap_or(0);
    let lim = limit.unwrap_or(500).min(10000);

    let logs: Vec<ParsedLog> = all_logs.into_iter().skip(off).take(lim).collect();

    Ok(LogsResponse {
        logs,
        total,
        offset: off,
        limit: lim,
    })
}

#[command]
pub async fn stream_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    stream_id: String,
    payload: StreamStartPayload,
) -> Result<(), KlvError> {
    let client = state.get_client().await?;

    state.stop_stream(&stream_id).await;

    let filter = build_filter(
        &payload.filters.as_ref().and_then(|f| f.level.clone()),
        &payload.filters.as_ref().and_then(|f| f.search.clone()),
        &payload.filters.as_ref().and_then(|f| f.exclude_patterns.clone()),
    );

    let mut handles = Vec::new();

    for pod_name in payload.pods {
        let client = client.clone();
        let namespace = payload.namespace.clone();
        let container = payload.container.clone();
        let filter = filter.clone();
        let app = app.clone();
        let pod = pod_name.clone();

        let handle = tokio::spawn(async move {
            use k8s_openapi::api::core::v1::Pod;
            use kube::api::{Api, LogParams};

            let pods_api: Api<Pod> = Api::namespaced(client, &namespace);

            let mut lp = LogParams::default();
            lp.follow = true;
            lp.tail_lines = Some(50);
            lp.timestamps = true;
            lp.container = container;

            match pods_api.log_stream(&pod, &lp).await {
                Ok(stream) => {
                    let lines = stream.lines();
                    futures::pin_mut!(lines);

                    loop {
                        match lines.try_next().await {
                            Ok(Some(line)) => {
                                let parsed = parse_log_line(&line, Some(&pod));
                                if matches_filter(&parsed, &filter) {
                                    let _ = app.emit("stream:log", &parsed);
                                }
                            }
                            Ok(None) => break,
                            Err(_) => break,
                        }
                    }
                }
                Err(e) => {
                    let _ = app.emit(
                        "stream:error",
                        serde_json::json!({
                            "podName": pod,
                            "error": e.to_string(),
                        }),
                    );
                }
            }
        });

        handles.push(handle);
    }

    state.register_stream(stream_id, handles).await;

    Ok(())
}

#[command]
pub async fn stream_stop(
    state: State<'_, Arc<AppState>>,
    stream_id: String,
) -> Result<(), KlvError> {
    state.stop_stream(&stream_id).await;
    Ok(())
}

fn build_filter(
    level: &Option<String>,
    search: &Option<String>,
    exclude_patterns: &Option<Vec<String>>,
) -> LogFilter {
    use crate::parser::log_parser::parse_log_level;
    LogFilter {
        level: None,
        min_level: level.as_ref().map(|l| parse_log_level(l)),
        search: search.clone(),
        trace_id: None,
        service: None,
        exclude_patterns: exclude_patterns.clone(),
    }
}
