use std::sync::Arc;

use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, ListParams};
use kube::config::Kubeconfig;
use kube::ResourceExt;
use tauri::{command, State};

use crate::commands::contexts::active_context;
use crate::error::KlvError;
use crate::state::AppState;

#[command]
pub async fn get_namespaces(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, KlvError> {
    let client = state.get_client().await?;

    let ns_api: Api<Namespace> = Api::all(client);

    match ns_api.list(&ListParams::default()).await {
        Ok(list) => Ok(list
            .items
            .iter()
            .map(|ns| ns.name_any())
            .filter(|n| !n.is_empty())
            .collect()),
        // Solo si listar namespaces está prohibido (RBAC); cualquier otro error se propaga
        Err(kube::Error::Api(resp)) if resp.code == 403 => {
            let namespace = match Kubeconfig::read() {
                Ok(kubeconfig) => {
                    let current = active_context(&state, &kubeconfig).await;
                    kubeconfig
                        .contexts
                        .iter()
                        .find(|c| Some(&c.name) == current.as_ref())
                        .and_then(|c| c.context.as_ref())
                        .and_then(|ctx| ctx.namespace.clone())
                }
                Err(_) => None,
            };
            Ok(vec![namespace.unwrap_or_else(|| "default".into())])
        }
        Err(e) => Err(KlvError::new(format!(
            "Error al obtener namespaces: {}",
            crate::error::kube_error_message(&e)
        ))),
    }
}
