use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::config::Kubeconfig;
use serde::Serialize;
use tauri::{command, State};

use crate::error::{kube_error_message, KlvError};
use crate::names::{validate_name, NameKind};
use crate::state::{build_client, AppState};

#[derive(Serialize, Clone)]
pub struct PodInfo {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub containers: Vec<String>,
    pub labels: BTreeMap<String, String>,
    pub age: String,
    pub restarts: BTreeMap<String, i32>,
}

#[command]
pub async fn get_pods(
    state: State<'_, Arc<AppState>>,
    namespace: String,
    label: Option<String>,
) -> Result<Vec<PodInfo>, KlvError> {
    validate_name(NameKind::Namespace, &namespace)?;
    let client = state.get_client().await?;

    let pods_api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut lp = ListParams::default();
    if let Some(sel) = &label {
        lp = lp.labels(sel);
    }

    let list = pods_api.list(&lp).await.map_err(|e| {
        KlvError::new(format!(
            "Error al obtener pods del namespace \"{namespace}\": {}",
            kube_error_message(&e)
        ))
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
                restarts: status
                    .and_then(|s| s.container_statuses.as_ref())
                    .map(|statuses| {
                        statuses
                            .iter()
                            .map(|cs| (cs.name.clone(), cs.restart_count))
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect();

    Ok(pods)
}

/// Nombres distintos (orden ascendente) de los contenedores de los pods del namespace.
/// Sin `context` usa el cliente activo; con `context` construye uno propio desde el kubeconfig.
#[command]
pub async fn get_containers(
    state: State<'_, Arc<AppState>>,
    context: Option<String>,
    namespace: String,
    label: Option<String>,
) -> Result<Vec<String>, KlvError> {
    validate_name(NameKind::Namespace, &namespace)?;
    let client = match context.as_deref().filter(|c| !c.is_empty()) {
        None => state.get_client().await?,
        Some(context) => {
            let kubeconfig = Kubeconfig::read()
                .map_err(|e| KlvError::new(format!("No se pudo leer kubeconfig: {e}")))?;
            if !kubeconfig.contexts.iter().any(|c| c.name == context) {
                return Err(KlvError::new(format!("Contexto \"{context}\" no existe")));
            }
            build_client(context).await.map_err(KlvError::new)?
        }
    };

    let pods_api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut lp = ListParams::default();
    if let Some(sel) = label.as_deref().filter(|s| !s.is_empty()) {
        lp = lp.labels(sel);
    }
    let list = pods_api.list(&lp).await.map_err(|e| {
        KlvError::new(format!(
            "Error al obtener pods del namespace \"{namespace}\": {}",
            kube_error_message(&e)
        ))
    })?;

    let names: BTreeSet<String> = list
        .items
        .iter()
        .filter_map(|pod| pod.spec.as_ref())
        .flat_map(|spec| spec.containers.iter().map(|c| c.name.clone()))
        .collect();
    Ok(names.into_iter().collect())
}

pub(crate) fn get_age(timestamp: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>) -> String {
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
