use std::sync::Arc;

use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::Client;
use serde::Serialize;
use tauri::{command, State};

use crate::error::KlvError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct ContextsResponse {
    pub current: String,
    pub contexts: Vec<String>,
}

/// `current` es el contexto del cliente que ejecuta los comandos; del kubeconfig solo se relee la lista.
#[command]
pub async fn get_contexts(state: State<'_, Arc<AppState>>) -> Result<ContextsResponse, KlvError> {
    let kubeconfig = Kubeconfig::read()
        .map_err(|e| KlvError::new(format!("No se pudo leer kubeconfig: {e}")))?;

    let current = state.active_context().await.unwrap_or_default();
    let contexts: Vec<String> = kubeconfig
        .contexts
        .iter()
        .map(|c| c.name.clone())
        .collect();

    Ok(ContextsResponse { current, contexts })
}

/// Cambia solo el cliente en proceso; no modifica el archivo kubeconfig. Detiene los streams activos.
#[command]
pub async fn set_context(state: State<'_, Arc<AppState>>, name: String) -> Result<(), KlvError> {
    let kubeconfig = Kubeconfig::read()
        .map_err(|e| KlvError::new(format!("No se pudo leer kubeconfig: {e}")))?;

    if !kubeconfig.contexts.iter().any(|c| c.name == name) {
        let available: Vec<&str> = kubeconfig.contexts.iter().map(|c| c.name.as_str()).collect();
        return Err(KlvError::with_status(
            404,
            format!(
                "Contexto \"{name}\" no existe. Disponibles: {}",
                available.join(", ")
            ),
        ));
    }

    let config = kube::Config::from_custom_kubeconfig(
        kubeconfig,
        &KubeConfigOptions {
            context: Some(name.clone()),
            ..Default::default()
        },
    )
    .await
    .map_err(|e| KlvError::new(format!("Error al cargar configuración: {e}")))?;

    let client = Client::try_from(config)
        .map_err(|e| KlvError::new(format!("Error al crear cliente K8s: {e}")))?;

    state.switch_context(client, name).await;

    Ok(())
}
