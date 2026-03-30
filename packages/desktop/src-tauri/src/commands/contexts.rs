use std::sync::Arc;

use serde::Serialize;
use tauri::{command, State};
use kube::Client;

use crate::error::KlvError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct ContextsResponse {
    pub current: String,
    pub contexts: Vec<String>,
}

#[command]
pub async fn get_contexts() -> Result<ContextsResponse, KlvError> {
    let kubeconfig = kube::config::Kubeconfig::read().map_err(|e| {
        KlvError::new(format!("No se pudo leer kubeconfig: {e}"))
    })?;

    let current = kubeconfig
        .current_context
        .clone()
        .unwrap_or_default();

    let contexts: Vec<String> = kubeconfig
        .contexts
        .iter()
        .map(|c| c.name.clone())
        .collect();

    Ok(ContextsResponse { current, contexts })
}

#[command]
pub async fn set_context(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<(), KlvError> {
    let kubeconfig_path = kube::config::Kubeconfig::read()
        .map_err(|e| KlvError::new(format!("No se pudo leer kubeconfig: {e}")))?;

    let exists = kubeconfig_path.contexts.iter().any(|c| c.name == name);
    if !exists {
        let available: Vec<String> = kubeconfig_path.contexts.iter().map(|c| c.name.clone()).collect();
        return Err(KlvError::new(format!(
            "Contexto \"{name}\" no existe. Disponibles: {}",
            available.join(", ")
        )));
    }

    let home = dirs::home_dir().ok_or_else(|| KlvError::new("No se encontró el directorio home"))?;
    let config_path = home.join(".kube").join("config");
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| KlvError::new(format!("Error al leer kubeconfig: {e}")))?;
    let updated = regex::Regex::new(r"(?m)^current-context:.*$")
        .unwrap()
        .replace(&content, &format!("current-context: {name}"));
    std::fs::write(&config_path, updated.as_ref())
        .map_err(|e| KlvError::new(format!("Error al escribir kubeconfig: {e}")))?;

    let config = kube::Config::from_kubeconfig(&kube::config::KubeConfigOptions {
        context: Some(name),
        ..Default::default()
    })
    .await
    .map_err(|e| KlvError::new(format!("Error al cargar configuración: {e}")))?;

    let client = Client::try_from(config)
        .map_err(|e| KlvError::new(format!("Error al crear cliente K8s: {e}")))?;

    *state.client.write().await = Some(client);

    Ok(())
}
