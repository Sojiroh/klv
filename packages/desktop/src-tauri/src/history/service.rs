//! Servicio de historial: configuración, colectores, retención y consultas.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use kube::config::Kubeconfig;
use tokio::task::JoinHandle;
use tokio::time::{interval, timeout, MissedTickBehavior};

use super::collector::RunningTarget;
use super::db::{blocking, now_micros, DbResult, Store};
use super::search::{run_query, QueryPlan};
use super::types::{
    CollectorStatus, CollectorTarget, HistoryConfig, HistoryConfigInput, HistoryQueryRequest,
    HistoryQueryResponse, HistoryStatus, TargetState,
};
use super::writer::{self, WriterTx};
use crate::error::KlvError;
use crate::names::{validate_name, NameKind};

const MAX_TARGETS: usize = 50;
const MAX_SELECTOR_LEN: usize = 1024;
const MAX_ID_LEN: usize = 64;
const MAX_AGE_DAYS: std::ops::RangeInclusive<i64> = 1..=365;
const MAX_SIZE_MB: std::ops::RangeInclusive<i64> = 64..=102_400;
const PRUNE_INTERVAL: Duration = Duration::from_secs(600);
const SHUTDOWN_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn generate_id(taken: &HashSet<String>) -> String {
    loop {
        let id = format!(
            "t{:x}{:x}",
            now_micros(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        );
        if !taken.contains(&id) {
            return id;
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Valida la configuración entrante (contrato Q5/C3) y asigna ids a los targets nuevos.
fn validate_config(input: HistoryConfigInput) -> Result<HistoryConfig, KlvError> {
    if input.targets.len() > MAX_TARGETS {
        return Err(KlvError::new(format!(
            "Demasiados targets: el máximo es {MAX_TARGETS}"
        )));
    }
    if !MAX_AGE_DAYS.contains(&input.retention.max_age_days) {
        return Err(KlvError::new(
            "maxAgeDays inválido: debe estar entre 1 y 365",
        ));
    }
    if !MAX_SIZE_MB.contains(&input.retention.max_size_mb) {
        return Err(KlvError::new(
            "maxSizeMb inválido: debe estar entre 64 y 102400",
        ));
    }

    let mut ids: HashSet<String> = HashSet::new();
    for id in input.targets.iter().filter_map(|t| t.id.as_deref()) {
        if !valid_id(id) {
            return Err(KlvError::new(format!("Id de target inválido: \"{id}\"")));
        }
        if !ids.insert(id.to_string()) {
            return Err(KlvError::new(format!("Id de target duplicado: \"{id}\"")));
        }
    }

    let contexts: Vec<String> = if input.targets.is_empty() {
        Vec::new()
    } else {
        Kubeconfig::read()
            .map_err(|e| KlvError::new(format!("No se pudo leer kubeconfig: {e}")))?
            .contexts
            .into_iter()
            .map(|c| c.name)
            .collect()
    };

    let mut targets = Vec::with_capacity(input.targets.len());
    for target in input.targets {
        if !contexts.contains(&target.context) {
            return Err(KlvError::new(format!(
                "Contexto \"{}\" no existe. Disponibles: {}",
                target.context,
                contexts.join(", ")
            )));
        }
        validate_name(NameKind::Namespace, &target.namespace)?;
        let container = target.container.filter(|c| !c.is_empty());
        if let Some(container) = &container {
            validate_name(NameKind::Container, container)?;
        }
        let label_selector = target.label_selector.filter(|s| !s.is_empty());
        if label_selector
            .as_deref()
            .is_some_and(|s| s.chars().count() > MAX_SELECTOR_LEN)
        {
            return Err(KlvError::new(format!(
                "labelSelector demasiado largo: el máximo es {MAX_SELECTOR_LEN} caracteres"
            )));
        }
        let id = match target.id {
            Some(id) => id,
            None => {
                let id = generate_id(&ids);
                ids.insert(id.clone());
                id
            }
        };
        targets.push(CollectorTarget {
            id,
            context: target.context,
            namespace: target.namespace,
            container,
            label_selector,
            enabled: target.enabled,
        });
    }

    Ok(HistoryConfig {
        targets,
        retention: input.retention,
    })
}

pub struct HistoryService {
    store: Arc<Store>,
    writer: WriterTx,
    running: Mutex<HashMap<String, RunningTarget>>,
    /// Serializa `history_set_config` (validar → guardar → reconciliar).
    config_lock: tokio::sync::Mutex<()>,
    retention_task: JoinHandle<()>,
}

async fn retention_loop(store: Arc<Store>) {
    let mut ticker = interval(PRUNE_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        // El primer tick es inmediato: poda al arrancar.
        ticker.tick().await;
        let store = store.clone();
        if let Err(e) = blocking(move || store.prune()).await {
            eprintln!("Historial: error en la retención: {e}");
        }
    }
}

impl HistoryService {
    /// Abre la base, arranca escritor, retención y los colectores de los targets habilitados.
    /// Requiere contexto de runtime de tokio.
    pub async fn start(db_path: PathBuf) -> DbResult<Arc<Self>> {
        let store = Arc::new(blocking(move || Store::open(&db_path)).await?);
        let config = {
            let store = store.clone();
            blocking(move || store.load_config()).await?
        };
        let service = Arc::new(Self {
            writer: writer::spawn_writer(store.clone()),
            retention_task: tokio::spawn(retention_loop(store.clone())),
            store,
            running: Mutex::new(HashMap::new()),
            config_lock: tokio::sync::Mutex::new(()),
        });
        service.reconcile(&config);
        Ok(service)
    }

    /// Alinea los colectores con la configuración: detiene los eliminados, deshabilitados o
    /// modificados y arranca los habilitados que no corren.
    fn reconcile(&self, config: &HistoryConfig) {
        let mut running = lock(&self.running);
        running.retain(|id, current| {
            config
                .targets
                .iter()
                .any(|t| t.enabled && t.id == *id && *t == current.target)
        });
        for target in config.targets.iter().filter(|t| t.enabled) {
            running.entry(target.id.clone()).or_insert_with(|| {
                RunningTarget::start(target.clone(), self.store.clone(), self.writer.clone())
            });
        }
    }

    pub async fn get_config(&self) -> DbResult<HistoryConfig> {
        let store = self.store.clone();
        blocking(move || store.load_config()).await
    }

    pub async fn set_config(&self, input: HistoryConfigInput) -> DbResult<HistoryConfig> {
        let _serialized = self.config_lock.lock().await;
        let config = validate_config(input)?;
        let store = self.store.clone();
        let to_save = config.clone();
        blocking(move || store.save_config(&to_save)).await?;
        self.reconcile(&config);
        Ok(config)
    }

    pub async fn status(&self) -> DbResult<HistoryStatus> {
        let store = self.store.clone();
        let (config, stats) = blocking(move || Ok((store.load_config()?, store.stats()?))).await?;

        let running = lock(&self.running);
        let collectors: Vec<CollectorStatus> = config
            .targets
            .iter()
            .map(|target| match running.get(&target.id) {
                Some(current) if target.enabled => current.status(),
                _ => CollectorStatus {
                    target_id: target.id.clone(),
                    state: TargetState::Disabled,
                    error: None,
                    streams: Vec::new(),
                },
            })
            .collect();

        Ok(HistoryStatus {
            stats,
            collectors,
            data_path: self.store.path().to_string_lossy().into_owned(),
        })
    }

    pub async fn query(&self, request: HistoryQueryRequest) -> DbResult<HistoryQueryResponse> {
        let plan = QueryPlan::new(request)?;
        let store = self.store.clone();
        blocking(move || run_query(&store.read_conn()?, &plan)).await
    }

    pub async fn clear(&self) -> DbResult<()> {
        writer::clear(&self.writer).await
    }

    /// Detiene los colectores y vuelca lo pendiente a disco.
    pub async fn shutdown(&self) {
        lock(&self.running).clear();
        self.retention_task.abort();
        let _ = timeout(SHUTDOWN_FLUSH_TIMEOUT, writer::shutdown(&self.writer)).await;
    }
}

/// Estado gestionado por Tauri; si la base no se pudo abrir, los comandos devuelven el error.
pub struct HistoryState {
    service: Result<Arc<HistoryService>, String>,
}

impl HistoryState {
    /// `data_dir`: directorio de datos de la app (se crea si no existe).
    pub async fn start(data_dir: Result<PathBuf, String>) -> Self {
        let service = match data_dir {
            Ok(dir) => {
                let db_path = dir.join("history.db");
                let created = blocking(move || {
                    std::fs::create_dir_all(&dir)
                        .map_err(|e| KlvError::new(format!("{}: {e}", dir.display())))?;
                    Ok(db_path)
                })
                .await;
                match created {
                    Ok(db_path) => HistoryService::start(db_path)
                        .await
                        .map_err(|e| e.message),
                    Err(e) => Err(e.message),
                }
            }
            Err(e) => Err(e),
        };
        if let Err(e) = &service {
            eprintln!("Historial no disponible: {e}");
        }
        Self { service }
    }

    pub fn service(&self) -> Result<&Arc<HistoryService>, KlvError> {
        self.service
            .as_ref()
            .map_err(|e| KlvError::new(format!("Historial no disponible: {e}")))
    }

    pub async fn shutdown(&self) {
        if let Ok(service) = &self.service {
            service.shutdown().await;
        }
    }
}
