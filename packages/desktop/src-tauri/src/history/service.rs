//! Servicio de historial: configuración, colectores, retención y consultas.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use kube::config::Kubeconfig;
use tokio::task::JoinHandle;
use tokio::time::{interval, timeout, MissedTickBehavior};

use super::collector::RunningTarget;
use super::db::{blocking, now_micros, DbResult, Store};
use super::legacy;
use super::search::{run_query, QueryPlan};
use super::types::{
    CollectorStatus, CollectorTarget, CollectorTargetInput, HistoryConfig, HistoryConfigInput,
    HistoryQueryRequest, HistoryQueryResponse, HistoryStatus, TargetState,
};
use super::writer::{self, WriterTx};
use crate::error::KlvError;
use crate::names::{validate_name, NameKind};
use crate::parser::log_parser::LogLevel;

const MAX_TARGETS: usize = 50;
const MAX_CONTAINERS: usize = 50;
const MAX_SELECTOR_LEN: usize = 1024;
const MAX_ID_LEN: usize = 64;
const MAX_EXCLUDE_PATTERNS: usize = 20;
const MAX_EXCLUDE_LEN: usize = 200;
const MAX_AGE_DAYS: std::ops::RangeInclusive<i64> = 1..=365;
const MAX_SIZE_MB: std::ops::RangeInclusive<i64> = 64..=102_400;
/// Rollover de horas completas y retención.
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60);
const SHUTDOWN_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_ROLLOVER_TIMEOUT: Duration = Duration::from_secs(10);
const CONFIG_FILE: &str = "config.json";

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

/// Nivel mínimo del target: vacío/ausente = sin filtro; UNKNOWN no es un valor válido.
fn validate_min_level(label: &str, raw: Option<String>) -> Result<Option<LogLevel>, KlvError> {
    match raw.as_deref() {
        None | Some("") => Ok(None),
        Some("TRACE") => Ok(Some(LogLevel::TRACE)),
        Some("DEBUG") => Ok(Some(LogLevel::DEBUG)),
        Some("INFO") => Ok(Some(LogLevel::INFO)),
        Some("WARN") => Ok(Some(LogLevel::WARN)),
        Some("ERROR") => Ok(Some(LogLevel::ERROR)),
        Some("FATAL") => Ok(Some(LogLevel::FATAL)),
        Some(_) => Err(KlvError::new(format!(
            "{label}: minLevel debe ser uno de TRACE, DEBUG, INFO, WARN, ERROR, FATAL"
        ))),
    }
}

/// Patrones de exclusión: hasta 20, cada uno de 1 a 200 caracteres y no vacío tras `trim`.
/// Una lista vacía equivale a no excluir nada.
fn validate_exclude(
    label: &str,
    patterns: Option<Vec<String>>,
) -> Result<Option<Vec<String>>, KlvError> {
    let Some(patterns) = patterns else {
        return Ok(None);
    };
    if patterns.len() > MAX_EXCLUDE_PATTERNS {
        return Err(KlvError::new(format!(
            "{label}: exclude debe ser un arreglo de hasta {MAX_EXCLUDE_PATTERNS} patrones"
        )));
    }
    if patterns
        .iter()
        .any(|p| p.trim().is_empty() || p.chars().count() > MAX_EXCLUDE_LEN)
    {
        return Err(KlvError::new(format!(
            "{label}: cada patrón de exclude debe ser un string no vacío de hasta {MAX_EXCLUDE_LEN} caracteres"
        )));
    }
    Ok((!patterns.is_empty()).then_some(patterns))
}

/// Contenedores del target: `trim`, sin vacíos ni duplicados (conserva el orden), hasta 50 y
/// cada uno un nombre válido; vacío = todos (`None`). El `container` heredado solo cuenta si
/// `containers` está ausente.
fn validate_containers(
    containers: Option<Vec<String>>,
    legacy: Option<String>,
) -> Result<Option<Vec<String>>, KlvError> {
    let raw = match containers {
        Some(containers) => containers,
        None => legacy.into_iter().collect(),
    };
    let mut names: Vec<String> = Vec::with_capacity(raw.len());
    for name in raw {
        let name = name.trim();
        if !name.is_empty() && !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    if names.len() > MAX_CONTAINERS {
        return Err(KlvError::new(format!(
            "containers: el máximo es {MAX_CONTAINERS} contenedores"
        )));
    }
    for name in &names {
        validate_name(NameKind::Container, name)?;
    }
    Ok((!names.is_empty()).then_some(names))
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
    for (index, target) in input.targets.into_iter().enumerate() {
        let CollectorTargetInput {
            id,
            context,
            namespace,
            containers,
            container,
            label_selector,
            enabled,
            min_level,
            exclude,
        } = target;
        if !contexts.contains(&context) {
            return Err(KlvError::new(format!(
                "Contexto \"{context}\" no existe. Disponibles: {}",
                contexts.join(", ")
            )));
        }
        validate_name(NameKind::Namespace, &namespace)?;
        let containers = validate_containers(containers, container)?;
        let label_selector = label_selector.filter(|s| !s.is_empty());
        if label_selector
            .as_deref()
            .is_some_and(|s| s.chars().count() > MAX_SELECTOR_LEN)
        {
            return Err(KlvError::new(format!(
                "labelSelector demasiado largo: el máximo es {MAX_SELECTOR_LEN} caracteres"
            )));
        }
        let label = format!("targets[{index}]");
        let min_level = validate_min_level(&label, min_level)?;
        let exclude = validate_exclude(&label, exclude)?;
        let id = match id {
            Some(id) => id,
            None => {
                let id = generate_id(&ids);
                ids.insert(id.clone());
                id
            }
        };
        targets.push(CollectorTarget {
            id,
            context,
            namespace,
            containers,
            label_selector,
            enabled,
            min_level,
            exclude,
        });
    }

    Ok(HistoryConfig {
        targets,
        retention: input.retention,
    })
}

// --- config.json ---

/// Carga la configuración; si falta o está corrupta se usan los valores por defecto (sin
/// sobrescribir el archivo hasta el próximo guardado).
fn read_config_file(path: &Path) -> HistoryConfig {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Historial: no se pudo leer {}: {e}", path.display());
            }
            return HistoryConfig::default();
        }
    };
    serde_json::from_str(&text).unwrap_or_else(|e| {
        eprintln!("Historial: {} está corrupto ({e}); se usan los valores por defecto", path.display());
        HistoryConfig::default()
    })
}

/// Escritura atómica: `<archivo>.tmp` y renombrado.
pub(super) fn write_config_file(path: &Path, config: &HistoryConfig) -> DbResult<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let json = serde_json::to_vec_pretty(config)?;
    fs::write(&tmp, json).map_err(|e| KlvError::new(format!("{}: {e}", tmp.display())))?;
    fs::rename(&tmp, path).map_err(|e| KlvError::new(format!("{}: {e}", path.display())))
}

pub struct HistoryService {
    store: Arc<Store>,
    config_path: PathBuf,
    config: Arc<Mutex<HistoryConfig>>,
    writer: WriterTx,
    running: Mutex<HashMap<String, RunningTarget>>,
    /// Serializa `history_set_config` (validar → guardar → reconciliar).
    config_lock: tokio::sync::Mutex<()>,
    maintenance_task: JoinHandle<()>,
}

/// Rollover de horas cerradas + retención (la poda inicial ocurre en el primer tick).
async fn maintenance_loop(store: Arc<Store>, config: Arc<Mutex<HistoryConfig>>) {
    let mut ticker = interval(MAINTENANCE_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let retention = lock(&config).retention;
        let store = store.clone();
        let result = blocking(move || {
            store.rollover()?;
            store.prune(&retention)
        })
        .await;
        if let Err(e) = result {
            eprintln!("Historial: error en el mantenimiento: {e}");
        }
    }
}

impl HistoryService {
    /// Migra el historial v1 si hace falta, abre el almacén y arranca escritor, mantenimiento y
    /// los colectores de los targets habilitados. Requiere contexto de runtime de tokio.
    pub async fn start(dir: PathBuf) -> DbResult<Arc<Self>> {
        let config_path = dir.join(CONFIG_FILE);
        let (store, config) = {
            let config_path = config_path.clone();
            blocking(move || {
                legacy::migrate_v1(&dir, &config_path)?;
                let store = Store::open(&dir)?;
                Ok((Arc::new(store), read_config_file(&config_path)))
            })
            .await?
        };
        let config = Arc::new(Mutex::new(config));
        let service = Arc::new(Self {
            writer: writer::spawn_writer(store.clone()),
            maintenance_task: tokio::spawn(maintenance_loop(store.clone(), config.clone())),
            store,
            config_path,
            config,
            running: Mutex::new(HashMap::new()),
            config_lock: tokio::sync::Mutex::new(()),
        });
        let initial = lock(&service.config).clone();
        service.reconcile(&initial);
        Ok(service)
    }

    /// Alinea los colectores con la configuración: detiene los eliminados, deshabilitados o
    /// modificados (incluidos `minLevel`/`exclude`) y arranca los habilitados que no corren.
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
        Ok(lock(&self.config).clone())
    }

    pub async fn set_config(&self, input: HistoryConfigInput) -> DbResult<HistoryConfig> {
        let _serialized = self.config_lock.lock().await;
        let config = validate_config(input)?;
        let path = self.config_path.clone();
        let to_save = config.clone();
        blocking(move || write_config_file(&path, &to_save)).await?;
        *lock(&self.config) = config.clone();
        self.reconcile(&config);

        // La retención puede haber cambiado: se aplica sin esperar al siguiente tick.
        let store = self.store.clone();
        let retention = config.retention;
        tokio::spawn(async move {
            if let Err(e) = blocking(move || store.prune(&retention)).await {
                eprintln!("Historial: error en la retención: {e}");
            }
        });
        Ok(config)
    }

    pub async fn status(&self) -> DbResult<HistoryStatus> {
        let config = lock(&self.config).clone();
        let store = self.store.clone();
        let stats = blocking(move || store.stats()).await?;

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
        blocking(move || run_query(&store.read_conn()?, store.segments_dir(), &plan)).await
    }

    pub async fn clear(&self) -> DbResult<()> {
        writer::clear(&self.writer).await
    }

    /// Detiene los colectores, vuelca lo pendiente y exporta las horas cerradas.
    pub async fn shutdown(&self) {
        lock(&self.running).clear();
        self.maintenance_task.abort();
        let _ = timeout(SHUTDOWN_FLUSH_TIMEOUT, writer::shutdown(&self.writer)).await;
        let store = self.store.clone();
        let rollover = timeout(
            SHUTDOWN_ROLLOVER_TIMEOUT,
            blocking(move || store.rollover()),
        )
        .await;
        if let Ok(Err(e)) = rollover {
            eprintln!("Historial: error al cerrar: {e}");
        }
    }
}

/// Estado gestionado por Tauri; si el almacén no se pudo abrir, los comandos devuelven el error.
pub struct HistoryState {
    service: Result<Arc<HistoryService>, String>,
}

impl HistoryState {
    /// `data_dir`: directorio de datos de la app (se crea si no existe).
    pub async fn start(data_dir: Result<PathBuf, String>) -> Self {
        let service = match data_dir {
            Ok(dir) => {
                let created = {
                    let dir = dir.clone();
                    blocking(move || {
                        fs::create_dir_all(&dir)
                            .map_err(|e| KlvError::new(format!("{}: {e}", dir.display())))
                    })
                    .await
                };
                match created {
                    Ok(()) => HistoryService::start(dir).await.map_err(|e| e.message),
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
