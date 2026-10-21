use std::sync::Arc;

use k8s_openapi::api::apps::v1::Deployment;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::{Client, ResourceExt};
use serde::Serialize;
use serde_json::json;
use tauri::{command, State};

use crate::commands::pods::get_age;
use crate::error::{kube_error_message, KlvError};
use crate::names::{validate_name, NameKind};
use crate::state::AppState;

/// Misma anotación que `kubectl rollout restart` y Lens.
const RESTARTED_AT_ANNOTATION: &str = "kubectl.kubernetes.io/restartedAt";

#[derive(Serialize, Clone)]
pub struct DeploymentCondition {
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
pub struct DeploymentInfo {
    pub name: String,
    pub namespace: String,
    /// Réplicas deseadas (`spec.replicas`) y conteos del status
    pub desired: i32,
    pub current: i32,
    pub ready: i32,
    pub updated: i32,
    pub available: i32,
    /// `observed_generation < generation`: el controller todavía no procesó el último cambio del spec
    pub generation: i64,
    pub observed_generation: i64,
    pub paused: bool,
    pub conditions: Vec<DeploymentCondition>,
    /// Fecha (RFC 3339) del último reinicio hecho con klv, kubectl o Lens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restarted_at: Option<String>,
    pub age: String,
}

fn to_deployment_info(deployment: &Deployment, namespace: &str) -> DeploymentInfo {
    let meta = &deployment.metadata;
    let spec = deployment.spec.as_ref();
    let status = deployment.status.as_ref();
    DeploymentInfo {
        name: deployment.name_any(),
        namespace: meta.namespace.clone().unwrap_or_else(|| namespace.to_string()),
        desired: spec.and_then(|s| s.replicas).unwrap_or(1),
        current: status.and_then(|s| s.replicas).unwrap_or(0),
        ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
        updated: status.and_then(|s| s.updated_replicas).unwrap_or(0),
        available: status.and_then(|s| s.available_replicas).unwrap_or(0),
        generation: meta.generation.unwrap_or(0),
        observed_generation: status.and_then(|s| s.observed_generation).unwrap_or(0),
        paused: spec.and_then(|s| s.paused).unwrap_or(false),
        conditions: status
            .and_then(|s| s.conditions.as_ref())
            .map(|conditions| {
                conditions
                    .iter()
                    .map(|c| DeploymentCondition {
                        type_: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone(),
                        message: c.message.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        restarted_at: spec
            .and_then(|s| s.template.metadata.as_ref())
            .and_then(|m| m.annotations.as_ref())
            .and_then(|a| a.get(RESTARTED_AT_ANNOTATION).cloned()),
        age: get_age(meta.creation_timestamp.as_ref()),
    }
}

pub async fn list(client: Client, namespace: &str) -> Result<Vec<DeploymentInfo>, KlvError> {
    let api: Api<Deployment> = Api::namespaced(client, namespace);
    let list = api.list(&ListParams::default()).await.map_err(|e| {
        KlvError::new(format!(
            "Error al obtener deployments del namespace \"{namespace}\": {}",
            kube_error_message(&e)
        ))
    })?;
    Ok(list
        .items
        .iter()
        .map(|d| to_deployment_info(d, namespace))
        .collect())
}

/// Como `kubectl rollout restart`: cambia una anotación del template y el controller reemplaza los pods
/// con la estrategia del deployment. Igual que kubectl, rechaza los deployments pausados.
pub async fn restart(client: Client, namespace: &str, name: &str) -> Result<DeploymentInfo, KlvError> {
    let action = format!("Error al reiniciar el deployment \"{name}\"");
    let fail = |e: kube::Error| KlvError::new(format!("{action}: {}", kube_error_message(&e)));
    let api: Api<Deployment> = Api::namespaced(client, namespace);

    let deployment = api.get(name).await.map_err(fail)?;
    if deployment.spec.as_ref().and_then(|s| s.paused).unwrap_or(false) {
        return Err(KlvError::new(format!(
            "{action}: está pausado, reanude el rollout primero"
        )));
    }

    let restarted_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let patch = json!({
        "spec": { "template": { "metadata": { "annotations": { RESTARTED_AT_ANNOTATION: restarted_at } } } }
    });
    let params = PatchParams {
        field_manager: Some("klv".into()),
        ..Default::default()
    };
    let patched = api
        .patch(name, &params, &Patch::Strategic(patch))
        .await
        .map_err(fail)?;
    Ok(to_deployment_info(&patched, namespace))
}

#[command]
pub async fn get_deployments(
    state: State<'_, Arc<AppState>>,
    namespace: String,
) -> Result<Vec<DeploymentInfo>, KlvError> {
    validate_name(NameKind::Namespace, &namespace)?;
    list(state.get_client().await?, &namespace).await
}

#[command]
pub async fn restart_deployment(
    state: State<'_, Arc<AppState>>,
    namespace: String,
    name: String,
) -> Result<DeploymentInfo, KlvError> {
    validate_name(NameKind::Namespace, &namespace)?;
    validate_name(NameKind::Deployment, &name)?;
    restart(state.get_client().await?, &namespace, &name).await
}
