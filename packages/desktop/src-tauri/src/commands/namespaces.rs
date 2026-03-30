use std::sync::Arc;

use tauri::{command, State};

use crate::error::KlvError;
use crate::state::AppState;

#[command]
pub async fn get_namespaces(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, KlvError> {
    let client = state.get_client().await?;

    use k8s_openapi::api::core::v1::Namespace;
    use kube::api::{Api, ListParams};
    use kube::ResourceExt;

    let ns_api: Api<Namespace> = Api::all(client.clone());

    match ns_api.list(&ListParams::default()).await {
        Ok(list) => {
            let names: Vec<String> = list
                .items
                .iter()
                .filter_map(|ns| Some(ns.name_any()))
                .filter(|n| !n.is_empty())
                .collect();
            Ok(names)
        }
        Err(_) => {
            let kubeconfig = kube::config::Kubeconfig::read()
                .map_err(|e| KlvError::new(format!("No se pudo leer kubeconfig: {e}")))?;
            let current = kubeconfig.current_context.as_deref().unwrap_or("");
            let ns = kubeconfig
                .contexts
                .iter()
                .find(|c| c.name == current)
                .and_then(|c| c.context.as_ref())
                .and_then(|ctx| ctx.namespace.clone())
                .unwrap_or_else(|| "default".into());
            Ok(vec![ns])
        }
    }
}
