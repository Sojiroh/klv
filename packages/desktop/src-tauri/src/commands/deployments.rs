use std::sync::Arc;

use tauri::{command, State};

use crate::error::KlvError;
use crate::state::AppState;

#[command]
pub async fn get_deployments(
    state: State<'_, Arc<AppState>>,
    namespace: String,
) -> Result<Vec<String>, KlvError> {
    let client = state.get_client().await?;

    use k8s_openapi::api::apps::v1::Deployment;
    use kube::api::{Api, ListParams};
    use kube::ResourceExt;

    let api: Api<Deployment> = Api::namespaced(client, &namespace);
    let list = api.list(&ListParams::default()).await.map_err(|e| {
        KlvError::new(format!("Error al obtener deployments del namespace \"{namespace}\": {e}"))
    })?;

    let names: Vec<String> = list
        .items
        .iter()
        .map(|d| d.name_any())
        .filter(|n| !n.is_empty())
        .collect();

    Ok(names)
}
