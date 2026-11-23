use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;

use kube::config::{KubeConfigOptions, Kubeconfig};
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

/// Cliente del arranque y su contexto, ambos de la misma lectura del kubeconfig (`current-context`).
/// Sin kubeconfig utilizable se cae a `Client::try_default` (in-cluster) y no hay nombre de contexto.
pub async fn initial_client() -> Result<(Client, Option<String>), String> {
    async fn from_kubeconfig() -> Result<(Client, Option<String>), String> {
        let kubeconfig = Kubeconfig::read().map_err(|e| e.to_string())?;
        let context = kubeconfig.current_context.clone();
        let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
            .await
            .map_err(|e| e.to_string())?;
        let client = Client::try_from(config).map_err(|e| e.to_string())?;
        Ok((client, context))
    }

    match from_kubeconfig().await {
        Ok(initial) => Ok(initial),
        Err(_) => Client::try_default()
            .await
            .map(|client| (client, None))
            .map_err(|e| e.to_string()),
    }
}

/// Cliente y nombre de su contexto: siempre se leen y se escriben juntos.
#[derive(Clone)]
struct Active {
    client: Client,
    /// `None` cuando el cliente no sale de un kubeconfig (in-cluster).
    context: Option<String>,
}

pub struct AppState {
    active: RwLock<Option<Active>>,
    /// Error de `initial_client` al arrancar; se devuelve mientras no haya cliente.
    init_error: Option<String>,
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
    pub fn new(initial: Result<(Client, Option<String>), String>) -> Arc<Self> {
        let (active, init_error) = match initial {
            Ok((client, context)) => (Some(Active { client, context }), None),
            Err(error) => (None, Some(error)),
        };
        Arc::new(Self {
            active: RwLock::new(active),
            init_error,
            streams: Mutex::new(HashMap::new()),
        })
    }

    fn not_initialized(&self) -> KlvError {
        KlvError::new(match &self.init_error {
            Some(error) => format!("Cliente Kubernetes no inicializado: {error}"),
            None => "Cliente Kubernetes no inicializado".to_string(),
        })
    }

    pub async fn get_client(&self) -> Result<Client, KlvError> {
        self.active
            .read()
            .await
            .as_ref()
            .map(|active| active.client.clone())
            .ok_or_else(|| self.not_initialized())
    }

    /// Contexto del cliente que ejecuta los comandos (nunca el `current-context` actual del disco).
    pub async fn active_context(&self) -> Option<String> {
        self.active
            .read()
            .await
            .as_ref()
            .and_then(|active| active.context.clone())
    }

    /// Sustituye cliente y contexto en una sola escritura y detiene los streams, que seguían
    /// leyendo del clúster anterior. Orden de locks: siempre `active` y luego `streams`; los streams
    /// se detienen con el guard de `active` tomado, así un `start_streams` concurrente registra
    /// antes (y se detiene aquí) o lee ya el cliente nuevo.
    pub async fn switch_context(&self, client: Client, context: String) {
        let mut active = self.active.write().await;
        *active = Some(Active {
            client,
            context: Some(context),
        });
        self.stop_all_streams().await;
    }

    /// Detiene todos los streams activos y registra los nuevos de forma atómica con el cliente activo:
    /// `spawn` recibe ese cliente y se ejecuta con los locks tomados (`active` en lectura hasta que los
    /// handles quedan registrados), así que dos inicios concurrentes no se mezclan y un cambio de
    /// contexto no deja streams del clúster anterior.
    pub async fn start_streams(
        &self,
        id: String,
        spawn: impl FnOnce(Client) -> Vec<JoinHandle<()>>,
    ) -> Result<(), KlvError> {
        let active = self.active.read().await;
        let client = active
            .as_ref()
            .map(|active| active.client.clone())
            .ok_or_else(|| self.not_initialized())?;
        let mut streams = self.streams.lock().await;
        abort_all(&mut streams);
        streams.insert(id, spawn(client));
        Ok(())
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
