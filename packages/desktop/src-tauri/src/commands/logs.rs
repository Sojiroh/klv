use std::sync::Arc;
use std::time::Duration;

use futures::{AsyncBufReadExt, AsyncReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams, LogParams};
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio::time::{interval, MissedTickBehavior};

use crate::error::{kube_error_message, KlvError};
use crate::names::{validate_name, NameKind};
use crate::parser::log_filter::{matches_filter, LogFilter};
use crate::parser::log_parser::{
    parse_log_level, parse_log_line, sort_logs_by_time, LogLevel, ParsedLog,
};
use crate::state::AppState;

const DEFAULT_TAIL: u64 = 100;
const MAX_TAIL: u64 = 10_000;
const MAX_LIMIT: usize = 10_000;
const MAX_CONCURRENT_FETCHES: usize = 8;

const STREAM_TAIL: i64 = 50;
const STREAM_MAX_PODS: usize = 100;
const STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(100);
const STREAM_MAX_BATCH: usize = 500;
const STREAM_CHANNEL_CAPACITY: usize = 2048;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQueryParams {
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
    pub tail: Option<u64>,
    pub since: Option<u64>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedPod {
    pub pod: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsResponse {
    pub logs: Vec<ParsedLog>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pods: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_pods: Option<Vec<FailedPod>>,
}

/// Parámetros de consulta ya validados (mismas reglas que la API HTTP).
struct QueryOptions {
    tail: i64,
    since: Option<i64>,
    filter: LogFilter,
    limit: Option<usize>,
    offset: usize,
}

impl QueryOptions {
    fn new(
        tail: Option<u64>,
        since: Option<u64>,
        level: Option<&str>,
        search: Option<String>,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> Result<Self, KlvError> {
        let since = match since {
            None => None,
            Some(0) => return Err(KlvError::new("since debe ser un número entero mayor o igual a 1")),
            Some(s) => Some(
                i64::try_from(s).map_err(|_| KlvError::new("since es demasiado grande"))?,
            ),
        };

        Ok(Self {
            // MAX_TAIL cabe de sobra en i64
            tail: tail.unwrap_or(DEFAULT_TAIL).min(MAX_TAIL) as i64,
            since,
            filter: build_filter(parse_min_level(level)?, search, None),
            limit: limit.map(|l| l.min(MAX_LIMIT)),
            offset: offset.unwrap_or(0),
        })
    }
}

/// `level` vacío o ausente = sin filtro; si viene, debe mapear a un nivel conocido.
fn parse_min_level(level: Option<&str>) -> Result<Option<LogLevel>, KlvError> {
    match level {
        None | Some("") => Ok(None),
        Some(raw) => match parse_log_level(raw) {
            LogLevel::UNKNOWN => Err(KlvError::new(format!(
                "Nivel inválido: {raw}. Válidos: TRACE, DEBUG, INFO, WARN, ERROR, FATAL"
            ))),
            level => Ok(Some(level)),
        },
    }
}

fn build_filter(
    min_level: Option<LogLevel>,
    search: Option<String>,
    exclude_patterns: Option<Vec<String>>,
) -> LogFilter {
    LogFilter {
        level: None,
        min_level,
        search,
        trace_id: None,
        service: None,
        exclude_patterns,
    }
}

/// Aplica offset/limit sobre las filas ya filtradas. Sin limit: todas desde `offset`.
fn paginate(mut logs: Vec<ParsedLog>, options: &QueryOptions) -> LogsResponse {
    let total = logs.len();
    logs.drain(..options.offset.min(total));
    if let Some(limit) = options.limit {
        logs.truncate(limit);
    }

    LogsResponse {
        logs,
        total,
        offset: options.offset,
        limit: options.limit.unwrap_or(total),
        pods: None,
        failed_pods: None,
    }
}

/// Descarga los logs de un pod (decodificación UTF-8 con pérdida) y devuelve las líneas
/// parseadas que pasan el filtro.
async fn fetch_pod_logs(
    api: &Api<Pod>,
    pod: &str,
    container: Option<&str>,
    options: &QueryOptions,
) -> Result<Vec<ParsedLog>, KlvError> {
    let lp = LogParams {
        container: container.map(String::from),
        tail_lines: Some(options.tail),
        since_seconds: options.since,
        timestamps: true,
        ..Default::default()
    };
    let fetch_error = |detail: String| {
        KlvError::new(format!("Error al obtener logs del pod \"{pod}\": {detail}"))
    };

    let reader = api
        .log_stream(pod, &lp)
        .await
        .map_err(|e| fetch_error(kube_error_message(&e)))?;
    futures::pin_mut!(reader);

    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| fetch_error(e.to_string()))?;

    let text = String::from_utf8_lossy(&bytes);
    Ok(text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| parse_log_line(line, Some(pod)))
        .filter(|log| matches_filter(log, &options.filter))
        .collect())
}

#[command]
pub async fn get_pod_logs(
    state: State<'_, Arc<AppState>>,
    params: LogQueryParams,
) -> Result<LogsResponse, KlvError> {
    validate_name(NameKind::Namespace, &params.namespace)?;
    validate_name(NameKind::Pod, &params.pod)?;
    if let Some(container) = &params.container {
        validate_name(NameKind::Container, container)?;
    }
    let options = QueryOptions::new(
        params.tail,
        params.since,
        params.level.as_deref(),
        params.search,
        params.limit,
        params.offset,
    )?;

    let client = state.get_client().await?;
    let pods_api: Api<Pod> = Api::namespaced(client, &params.namespace);

    let logs = fetch_pod_logs(&pods_api, &params.pod, params.container.as_deref(), &options).await?;

    Ok(paginate(logs, &options))
}

// Los argumentos son los de `invoke('get_container_logs', ...)` del cliente JS (planos, por nombre).
#[allow(clippy::too_many_arguments)]
#[command]
pub async fn get_container_logs(
    state: State<'_, Arc<AppState>>,
    namespace: String,
    container: String,
    tail: Option<u64>,
    since: Option<u64>,
    level: Option<String>,
    search: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<LogsResponse, KlvError> {
    validate_name(NameKind::Namespace, &namespace)?;
    validate_name(NameKind::Container, &container)?;
    let options = QueryOptions::new(tail, since, level.as_deref(), search, limit, offset)?;

    let client = state.get_client().await?;
    let pods_api: Api<Pod> = Api::namespaced(client, &namespace);

    let list = pods_api
        .list(&ListParams::default())
        .await
        .map_err(|e| KlvError::new(format!("Error al obtener pods: {}", kube_error_message(&e))))?;

    let matching_pods: Vec<String> = list
        .items
        .into_iter()
        .filter(|pod| {
            pod.spec
                .as_ref()
                .is_some_and(|s| s.containers.iter().any(|c| c.name == container))
        })
        .filter_map(|pod| pod.metadata.name)
        .collect();

    if matching_pods.is_empty() {
        return Ok(LogsResponse {
            logs: Vec::new(),
            total: 0,
            offset: 0,
            limit: 0,
            pods: Some(Vec::new()),
            failed_pods: Some(Vec::new()),
        });
    }

    // `buffered` conserva el orden de los pods, así `failedPods` es determinista
    let results: Vec<(String, Result<Vec<ParsedLog>, KlvError>)> =
        futures::stream::iter(matching_pods.clone())
            .map(|pod| {
                let api = &pods_api;
                let options = &options;
                let container = container.as_str();
                async move {
                    let result = fetch_pod_logs(api, &pod, Some(container), options).await;
                    (pod, result)
                }
            })
            .buffered(MAX_CONCURRENT_FETCHES)
            .collect()
            .await;

    let mut all_logs: Vec<ParsedLog> = Vec::new();
    let mut failed_pods: Vec<FailedPod> = Vec::new();
    let mut first_error: Option<KlvError> = None;
    for (pod, result) in results {
        match result {
            Ok(logs) => all_logs.extend(logs),
            Err(e) => {
                failed_pods.push(FailedPod {
                    pod,
                    error: e.message.clone(),
                });
                first_error.get_or_insert(e);
            }
        }
    }

    if failed_pods.len() == matching_pods.len() {
        if let Some(e) = first_error {
            return Err(e);
        }
    }

    // Las filas ya pasaron el filtro (que es por fila), así que ordenar ahora da el mismo
    // resultado que ordenar antes de filtrar.
    sort_logs_by_time(&mut all_logs);

    let mut response = paginate(all_logs, &options);
    response.pods = Some(matching_pods);
    response.failed_pods = Some(failed_pods);
    Ok(response)
}

/// Mensajes de un stream hacia el flusher; un único canal por stream preserva el orden
/// entre líneas y eventos de fin/error.
enum StreamEvent {
    Log(Box<ParsedLog>),
    End { pod_name: String },
    Error { pod_name: String, error: String },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogBatchPayload<'a> {
    stream_id: &'a str,
    logs: &'a [ParsedLog],
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamErrorPayload<'a> {
    stream_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pod_name: Option<&'a str>,
    error: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamEndPayload<'a> {
    stream_id: &'a str,
    pod_name: &'a str,
}

fn emit_stream_error(app: &AppHandle, stream_id: &str, pod_name: Option<&str>, error: &str) {
    let _ = app.emit(
        "stream:error",
        StreamErrorPayload {
            stream_id,
            pod_name,
            error,
        },
    );
}

fn emit_pending_logs(app: &AppHandle, stream_id: &str, pending: &mut Vec<ParsedLog>) {
    if pending.is_empty() {
        return;
    }
    let _ = app.emit(
        "stream:log",
        LogBatchPayload {
            stream_id,
            logs: pending.as_slice(),
        },
    );
    pending.clear();
}

/// Agrupa las líneas del stream y las emite cada 100 ms o al llegar a 500 pendientes.
/// Termina cuando todos los lectores han soltado su `Sender`.
async fn flush_stream_events(
    app: AppHandle,
    stream_id: String,
    mut rx: mpsc::Receiver<StreamEvent>,
) {
    let mut pending: Vec<ParsedLog> = Vec::new();
    let mut ticker = interval(STREAM_FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Some(StreamEvent::Log(log)) => {
                    pending.push(*log);
                    if pending.len() >= STREAM_MAX_BATCH {
                        emit_pending_logs(&app, &stream_id, &mut pending);
                    }
                }
                Some(StreamEvent::End { pod_name }) => {
                    emit_pending_logs(&app, &stream_id, &mut pending);
                    let _ = app.emit(
                        "stream:end",
                        StreamEndPayload { stream_id: &stream_id, pod_name: &pod_name },
                    );
                }
                Some(StreamEvent::Error { pod_name, error }) => {
                    emit_pending_logs(&app, &stream_id, &mut pending);
                    emit_stream_error(&app, &stream_id, Some(&pod_name), &error);
                }
                None => {
                    emit_pending_logs(&app, &stream_id, &mut pending);
                    break;
                }
            },
            _ = ticker.tick() => emit_pending_logs(&app, &stream_id, &mut pending),
        }
    }
}

/// Lee el follow-stream de un pod línea a línea (UTF-8 con pérdida) y lo envía al flusher.
async fn read_pod_stream(
    client: kube::Client,
    namespace: String,
    pod: String,
    container: Option<String>,
    filter: Arc<LogFilter>,
    tx: mpsc::Sender<StreamEvent>,
) {
    let pods_api: Api<Pod> = Api::namespaced(client, &namespace);
    let lp = LogParams {
        follow: true,
        tail_lines: Some(STREAM_TAIL),
        timestamps: true,
        container,
        ..Default::default()
    };

    let reader = match pods_api.log_stream(&pod, &lp).await {
        Ok(reader) => reader,
        Err(e) => {
            let error = kube_error_message(&e);
            let _ = tx.send(StreamEvent::Error { pod_name: pod, error }).await;
            return;
        }
    };
    futures::pin_mut!(reader);

    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => {
                let _ = tx.send(StreamEvent::End { pod_name: pod }).await;
                return;
            }
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf);
                let line = text.trim_end_matches(['\n', '\r']);
                if line.trim().is_empty() {
                    continue;
                }
                let parsed = parse_log_line(line, Some(&pod));
                if matches_filter(&parsed, &filter)
                    && tx.send(StreamEvent::Log(Box::new(parsed))).await.is_err()
                {
                    return;
                }
            }
            Err(e) => {
                let error = e.to_string();
                let _ = tx.send(StreamEvent::Error { pod_name: pod, error }).await;
                return;
            }
        }
    }
}

fn validate_stream_payload(payload: &StreamStartPayload) -> Result<LogFilter, KlvError> {
    validate_name(NameKind::Namespace, &payload.namespace)?;
    if payload.pods.is_empty() || payload.pods.len() > STREAM_MAX_PODS {
        return Err(KlvError::new(format!(
            "pods debe ser una lista de 1 a {STREAM_MAX_PODS} nombres"
        )));
    }
    for pod in &payload.pods {
        validate_name(NameKind::Pod, pod)?;
    }
    if let Some(container) = &payload.container {
        validate_name(NameKind::Container, container)?;
    }

    let filters = payload.filters.as_ref();
    let min_level = parse_min_level(filters.and_then(|f| f.level.as_deref()))?;
    Ok(build_filter(
        min_level,
        filters.and_then(|f| f.search.clone()),
        filters.and_then(|f| f.exclude_patterns.clone()),
    ))
}

#[command]
pub async fn stream_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    stream_id: String,
    payload: StreamStartPayload,
) -> Result<(), KlvError> {
    // Un único conjunto de streams activo: cualquier inicio detiene los anteriores
    state.stop_all_streams().await;

    let filter = match validate_stream_payload(&payload) {
        Ok(filter) => Arc::new(filter),
        Err(e) => {
            emit_stream_error(&app, &stream_id, None, &e.message);
            return Ok(());
        }
    };
    let client = state.get_client().await?;

    let StreamStartPayload {
        namespace,
        pods,
        container,
        ..
    } = payload;
    let id = stream_id.clone();

    state
        .replace_streams(stream_id, move || {
            let (tx, rx) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
            let mut handles = Vec::with_capacity(pods.len() + 1);
            handles.push(tokio::spawn(flush_stream_events(app, id, rx)));
            for pod in pods {
                handles.push(tokio::spawn(read_pod_stream(
                    client.clone(),
                    namespace.clone(),
                    pod,
                    container.clone(),
                    filter.clone(),
                    tx.clone(),
                )));
            }
            handles
        })
        .await;

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
