use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;

use kube::config::KubeConfigOptions;
use kube::{Client, Config};

use crate::error::KlvError;

/// Cliente de Kubernetes propio para `context`, cargado del kubeconfig.
pub async fn build_client(context: &str) -> Result<Client, String> {
    let options = KubeConfigOptions {
        context: Some(context.to_string()),
        ..Default::default()
    };
    let config = Config::from_kubeconfig(&options)
        .await
        .map_err(|e| format!("No se pudo cargar la configuración del contexto \"{context}\": {e}"))?;
    Client::try_from(config)
        .map_err(|e| format!("No se pudo crear el cliente de Kubernetes: {e}"))
}

pub struct AppState {
    pub client: RwLock<Option<Client>>,
    /// Error de `Client::try_default` al arrancar; se devuelve mientras no haya cliente.
    init_error: Option<String>,
    /// Contexto del cliente en uso tras un `set_context`; `None` = el del kubeconfig al arrancar.
    pub active_context: RwLock<Option<String>>,
    streams: Mutex<HashMap<String, Vec<JoinHandle<()>>>>,
}

fn abort_all(streams: &mut HashMap<String, Vec<JoinHandle<()>>>) {
    for (_, handles) in streams.drain() {
        for handle in handles {
            handle.abort();
        }
    }
}

impl AppState {
    pub fn new(client: Result<Client, String>) -> Arc<Self> {
        let (client, init_error) = match client {
            Ok(client) => (Some(client), None),
            Err(error) => (None, Some(error)),
        };
        Arc::new(Self {
            client: RwLock::new(client),
            init_error,
            active_context: RwLock::new(None),
            streams: Mutex::new(HashMap::new()),
        })
    }

    pub async fn get_client(&self) -> Result<Client, KlvError> {
        self.client.read().await.clone().ok_or_else(|| {
            KlvError::new(match &self.init_error {
                Some(error) => format!("Cliente Kubernetes no inicializado: {error}"),
                None => "Cliente Kubernetes no inicializado".to_string(),
            })
        })
    }

    /// Detiene todos los streams activos y registra los nuevos de forma atómica:
    /// `spawn` se ejecuta con el lock tomado, así que dos inicios concurrentes no se mezclan.
    pub async fn replace_streams(
        &self,
        id: String,
        spawn: impl FnOnce() -> Vec<JoinHandle<()>>,
    ) {
        let mut streams = self.streams.lock().await;
        abort_all(&mut streams);
        streams.insert(id, spawn());
    }

    pub async fn stop_stream(&self, id: &str) {
        if let Some(handles) = self.streams.lock().await.remove(id) {
            for handle in handles {
                handle.abort();
            }
        }
    }

    pub async fn stop_all_streams(&self) {
        let mut streams = self.streams.lock().await;
        abort_all(&mut streams);
    }
}
