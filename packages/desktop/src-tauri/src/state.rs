use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

use kube::Client;

pub struct AppState {
    pub client: RwLock<Option<Client>>,
    pub streams: RwLock<HashMap<String, Vec<JoinHandle<()>>>>,
}

impl AppState {
    pub fn new(client: Option<Client>) -> Arc<Self> {
        Arc::new(Self {
            client: RwLock::new(client),
            streams: RwLock::new(HashMap::new()),
        })
    }

    pub async fn get_client(&self) -> Result<Client, crate::error::KlvError> {
        self.client
            .read()
            .await
            .clone()
            .ok_or_else(|| crate::error::KlvError::new("Cliente Kubernetes no inicializado"))
    }

    pub async fn register_stream(&self, id: String, handles: Vec<JoinHandle<()>>) {
        self.streams.write().await.insert(id, handles);
    }

    pub async fn stop_stream(&self, id: &str) {
        if let Some(handles) = self.streams.write().await.remove(id) {
            for h in handles {
                h.abort();
            }
        }
    }
}
