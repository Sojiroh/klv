use std::sync::Arc;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::PodTemplateSpec;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::{Client, ResourceExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{command, State};

use crate::commands::pods::get_age;
use crate::error::{kube_error_message, KlvError};
use crate::names::{validate_name, NameKind};
use crate::state::AppState;

/// Misma anotación que `kubectl rollout restart` y Lens.
const RESTARTED_AT_ANNOTATION: &str = "kubectl.kubernetes.io/restartedAt";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkloadKind {
    Deployment,
    StatefulSet,
    DaemonSet,
}

impl WorkloadKind {
    /// Para mensajes y validación de nombres: "deployment", "statefulset", "daemonset"
    fn label(self) -> &'static str {
        match self {
            WorkloadKind::Deployment => "deployment",
            WorkloadKind::StatefulSet => "statefulset",
            WorkloadKind::DaemonSet => "daemonset",
        }
    }

    fn name_kind(self) -> NameKind {
        match self {
            WorkloadKind::Deployment => NameKind::Deployment,
            WorkloadKind::StatefulSet => NameKind::StatefulSet,
            WorkloadKind::DaemonSet => NameKind::DaemonSet,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct WorkloadCondition {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadInfo {
    pub kind: WorkloadKind,
    pub name: String,
    pub namespace: String,
    /// Pods deseados y conteos del status (DaemonSet: pods programados en los nodos)
    pub desired: i32,
    pub current: i32,
    pub ready: i32,
    pub updated: i32,
    pub available: i32,
    /// Deployment: RollingUpdate | Recreate; StatefulSet y DaemonSet: RollingUpdate | OnDelete
    pub strategy: String,
    /// StatefulSet: los pods con ordinal menor que la partición no se actualizan (0 en los demás tipos)
    pub partition: i32,
    /// Solo los deployments se pausan
    pub paused: bool,
    /// `observed_generation < generation`: el controller todavía no procesó el último cambio del spec
    pub generation: i64,
    pub observed_generation: i64,
    pub conditions: Vec<WorkloadCondition>,
    /// Fecha (RFC 3339) del último reinicio hecho con klv, kubectl o Lens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restarted_at: Option<String>,
    pub age: String,
}

fn condition(type_: &str, status: &str, reason: &Option<String>, message: &Option<String>) -> WorkloadCondition {
    WorkloadCondition {
        type_: type_.to_string(),
        status: status.to_string(),
        reason: reason.clone(),
        message: message.clone(),
    }
}

fn restarted_at(template: Option<&PodTemplateSpec>) -> Option<String> {
    template?
        .metadata
        .as_ref()?
        .annotations
        .as_ref()?
        .get(RESTARTED_AT_ANNOTATION)
        .cloned()
}

fn from_deployment(d: &Deployment, namespace: &str) -> WorkloadInfo {
    let spec = d.spec.as_ref();
    let status = d.status.as_ref();
    WorkloadInfo {
        kind: WorkloadKind::Deployment,
        name: d.name_any(),
        namespace: d.metadata.namespace.clone().unwrap_or_else(|| namespace.to_string()),
        desired: spec.and_then(|s| s.replicas).unwrap_or(1),
        current: status.and_then(|s| s.replicas).unwrap_or(0),
        ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
        updated: status.and_then(|s| s.updated_replicas).unwrap_or(0),
        available: status.and_then(|s| s.available_replicas).unwrap_or(0),
        strategy: spec
            .and_then(|s| s.strategy.as_ref())
            .and_then(|s| s.type_.clone())
            .unwrap_or_else(|| "RollingUpdate".into()),
        partition: 0,
        paused: spec.and_then(|s| s.paused).unwrap_or(false),
        generation: d.metadata.generation.unwrap_or(0),
        observed_generation: status.and_then(|s| s.observed_generation).unwrap_or(0),
        conditions: status
            .and_then(|s| s.conditions.as_ref())
            .map(|cs| cs.iter().map(|c| condition(&c.type_, &c.status, &c.reason, &c.message)).collect())
            .unwrap_or_default(),
        restarted_at: restarted_at(spec.map(|s| &s.template)),
        age: get_age(d.metadata.creation_timestamp.as_ref()),
    }
}

fn from_statefulset(s: &StatefulSet, namespace: &str) -> WorkloadInfo {
    let spec = s.spec.as_ref();
    let status = s.status.as_ref();
    let update_strategy = spec.and_then(|s| s.update_strategy.as_ref());
    WorkloadInfo {
        kind: WorkloadKind::StatefulSet,
        name: s.name_any(),
        namespace: s.metadata.namespace.clone().unwrap_or_else(|| namespace.to_string()),
        desired: spec.and_then(|s| s.replicas).unwrap_or(1),
        current: status.map(|s| s.replicas).unwrap_or(0),
        ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
        updated: status.and_then(|s| s.updated_replicas).unwrap_or(0),
        available: status.and_then(|s| s.available_replicas).unwrap_or(0),
        strategy: update_strategy
            .and_then(|u| u.type_.clone())
            .unwrap_or_else(|| "RollingUpdate".into()),
        partition: update_strategy
            .and_then(|u| u.rolling_update.as_ref())
            .and_then(|r| r.partition)
            .unwrap_or(0),
        paused: false,
        generation: s.metadata.generation.unwrap_or(0),
        observed_generation: status.and_then(|s| s.observed_generation).unwrap_or(0),
        conditions: status
            .and_then(|s| s.conditions.as_ref())
            .map(|cs| cs.iter().map(|c| condition(&c.type_, &c.status, &c.reason, &c.message)).collect())
            .unwrap_or_default(),
        restarted_at: restarted_at(spec.map(|s| &s.template)),
        age: get_age(s.metadata.creation_timestamp.as_ref()),
    }
}

fn from_daemonset(d: &DaemonSet, namespace: &str) -> WorkloadInfo {
    let spec = d.spec.as_ref();
    let status = d.status.as_ref();
    WorkloadInfo {
        kind: WorkloadKind::DaemonSet,
        name: d.name_any(),
        namespace: d.metadata.namespace.clone().unwrap_or_else(|| namespace.to_string()),
        desired: status.map(|s| s.desired_number_scheduled).unwrap_or(0),
        current: status.map(|s| s.current_number_scheduled).unwrap_or(0),
        ready: status.map(|s| s.number_ready).unwrap_or(0),
        updated: status.and_then(|s| s.updated_number_scheduled).unwrap_or(0),
        available: status.and_then(|s| s.number_available).unwrap_or(0),
        strategy: spec
            .and_then(|s| s.update_strategy.as_ref())
            .and_then(|u| u.type_.clone())
            .unwrap_or_else(|| "RollingUpdate".into()),
        partition: 0,
        paused: false,
        generation: d.metadata.generation.unwrap_or(0),
        observed_generation: status.and_then(|s| s.observed_generation).unwrap_or(0),
        conditions: status
            .and_then(|s| s.conditions.as_ref())
            .map(|cs| cs.iter().map(|c| condition(&c.type_, &c.status, &c.reason, &c.message)).collect())
            .unwrap_or_default(),
        restarted_at: restarted_at(spec.map(|s| &s.template)),
        age: get_age(d.metadata.creation_timestamp.as_ref()),
    }
}

pub async fn list(client: Client, kind: WorkloadKind, namespace: &str) -> Result<Vec<WorkloadInfo>, KlvError> {
    let fail = |e: kube::Error| {
        KlvError::new(format!(
            "Error al obtener {}s del namespace \"{namespace}\": {}",
            kind.label(),
            kube_error_message(&e)
        ))
    };
    let lp = ListParams::default();
    Ok(match kind {
        WorkloadKind::Deployment => Api::<Deployment>::namespaced(client, namespace)
            .list(&lp)
            .await
            .map_err(fail)?
            .items
            .iter()
            .map(|d| from_deployment(d, namespace))
            .collect(),
        WorkloadKind::StatefulSet => Api::<StatefulSet>::namespaced(client, namespace)
            .list(&lp)
            .await
            .map_err(fail)?
            .items
            .iter()
            .map(|s| from_statefulset(s, namespace))
            .collect(),
        WorkloadKind::DaemonSet => Api::<DaemonSet>::namespaced(client, namespace)
            .list(&lp)
            .await
            .map_err(fail)?
            .items
            .iter()
            .map(|d| from_daemonset(d, namespace))
            .collect(),
    })
}

/// Como `kubectl rollout restart`: cambia una anotación del template y el controller reemplaza los pods con
/// su estrategia (con OnDelete, solo cuando se borran). Igual que kubectl, rechaza los deployments pausados.
pub async fn restart(
    client: Client,
    kind: WorkloadKind,
    namespace: &str,
    name: &str,
) -> Result<WorkloadInfo, KlvError> {
    let action = format!("Error al reiniciar el {} \"{name}\"", kind.label());
    let fail = |e: kube::Error| KlvError::new(format!("{action}: {}", kube_error_message(&e)));

    let restarted_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let patch = Patch::Strategic(json!({
        "spec": { "template": { "metadata": { "annotations": { RESTARTED_AT_ANNOTATION: restarted_at } } } }
    }));
    let params = PatchParams {
        field_manager: Some("klv".into()),
        ..Default::default()
    };

    match kind {
        WorkloadKind::Deployment => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            let deployment = api.get(name).await.map_err(fail)?;
            if deployment.spec.as_ref().and_then(|s| s.paused).unwrap_or(false) {
                return Err(KlvError::new(format!(
                    "{action}: está pausado, reanude el rollout primero"
                )));
            }
            let patched = api.patch(name, &params, &patch).await.map_err(fail)?;
            Ok(from_deployment(&patched, namespace))
        }
        WorkloadKind::StatefulSet => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            let patched = api.patch(name, &params, &patch).await.map_err(fail)?;
            Ok(from_statefulset(&patched, namespace))
        }
        WorkloadKind::DaemonSet => {
            let api: Api<DaemonSet> = Api::namespaced(client, namespace);
            let patched = api.patch(name, &params, &patch).await.map_err(fail)?;
            Ok(from_daemonset(&patched, namespace))
        }
    }
}

/// Como `kubectl scale`: merge patch de `spec.replicas` en el subrecurso scale. Los daemonsets no se escalan.
pub async fn scale(
    client: Client,
    kind: WorkloadKind,
    namespace: &str,
    name: &str,
    replicas: i64,
) -> Result<WorkloadInfo, KlvError> {
    if kind == WorkloadKind::DaemonSet {
        return Err(KlvError::new(
            "Los daemonsets no se escalan: ejecutan un pod por nodo",
        ));
    }
    if !(0..=i64::from(i32::MAX)).contains(&replicas) {
        return Err(KlvError::new(format!("Número de réplicas inválido: {replicas}")));
    }

    let action = format!("Error al escalar el {} \"{name}\"", kind.label());
    let fail = |e: kube::Error| KlvError::new(format!("{action}: {}", kube_error_message(&e)));
    let patch = Patch::Merge(json!({ "spec": { "replicas": replicas } }));
    let params = PatchParams {
        field_manager: Some("klv".into()),
        ..Default::default()
    };

    if kind == WorkloadKind::Deployment {
        let api: Api<Deployment> = Api::namespaced(client, namespace);
        api.patch_scale(name, &params, &patch).await.map_err(fail)?;
        Ok(from_deployment(&api.get(name).await.map_err(fail)?, namespace))
    } else {
        let api: Api<StatefulSet> = Api::namespaced(client, namespace);
        api.patch_scale(name, &params, &patch).await.map_err(fail)?;
        Ok(from_statefulset(&api.get(name).await.map_err(fail)?, namespace))
    }
}

#[command]
pub async fn get_workloads(
    state: State<'_, Arc<AppState>>,
    kind: WorkloadKind,
    namespace: String,
) -> Result<Vec<WorkloadInfo>, KlvError> {
    validate_name(NameKind::Namespace, &namespace)?;
    list(state.get_client().await?, kind, &namespace).await
}

#[command]
pub async fn restart_workload(
    state: State<'_, Arc<AppState>>,
    kind: WorkloadKind,
    namespace: String,
    name: String,
) -> Result<WorkloadInfo, KlvError> {
    validate_name(NameKind::Namespace, &namespace)?;
    validate_name(kind.name_kind(), &name)?;
    restart(state.get_client().await?, kind, &namespace, &name).await
}

#[command]
pub async fn scale_workload(
    state: State<'_, Arc<AppState>>,
    kind: WorkloadKind,
    namespace: String,
    name: String,
    replicas: i64,
) -> Result<WorkloadInfo, KlvError> {
    validate_name(NameKind::Namespace, &namespace)?;
    validate_name(kind.name_kind(), &name)?;
    scale(state.get_client().await?, kind, &namespace, &name, replicas).await
}
