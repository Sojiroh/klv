use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::{command, State};

use crate::error::KlvError;
use crate::state::AppState;

#[derive(Serialize, Clone)]
pub struct PodInfo {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub containers: Vec<String>,
    pub labels: BTreeMap<String, String>,
    pub age: String,
}

#[command]
pub async fn get_pods(
    state: State<'_, Arc<AppState>>,
    namespace: String,
    label: Option<String>,
) -> Result<Vec<PodInfo>, KlvError> {
    let client = state.get_client().await?;

    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{Api, ListParams};

    let pods_api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut lp = ListParams::default();
    if let Some(sel) = &label {
        lp = lp.labels(sel);
    }

    let list = pods_api.list(&lp).await.map_err(|e| {
        KlvError::new(format!("Error al obtener pods del namespace \"{namespace}\": {e}"))
    })?;

    let pods: Vec<PodInfo> = list
        .items
        .iter()
        .map(|pod| {
            let meta = pod.metadata.clone();
            let spec = pod.spec.as_ref();
            let status = pod.status.as_ref();
            PodInfo {
                name: meta.name.unwrap_or_default(),
                namespace: meta.namespace.unwrap_or_else(|| namespace.clone()),
                status: status
                    .and_then(|s| s.phase.clone())
                    .unwrap_or_else(|| "Unknown".into()),
                containers: spec
                    .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
                    .unwrap_or_default(),
                labels: meta.labels.unwrap_or_default(),
                age: get_age(meta.creation_timestamp.as_ref()),
            }
        })
        .collect();

    Ok(pods)
}

fn get_age(timestamp: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>) -> String {
    let Some(ts) = timestamp else {
        return "Unknown".into();
    };
    let now = chrono::Utc::now();
    let created: chrono::DateTime<chrono::Utc> = ts.0;
    let diff = now.signed_duration_since(created);
    let secs = diff.num_seconds();
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = hours / 24;
    format!("{days}d")
}
