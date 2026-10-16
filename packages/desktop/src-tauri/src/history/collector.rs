//! Colector continuo: un cliente de Kubernetes propio por target, descubrimiento de pods con
//! `watcher` (list + watch) y un seguidor `log_stream` por pod × contenedor.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use kube::runtime::watcher::{self, watcher, Event};
use kube::runtime::WatchStreamExt;
use kube::Client;
use tokio::task::{AbortHandle, JoinHandle, JoinSet};
use tokio::time::sleep;

use super::db::{blocking, micros_to_iso, now_micros, NewRow, Store};
use super::types::{CollectorStatus, CollectorStream, CollectorTarget, StreamState, TargetState};
use super::writer::{WriterMsg, WriterTx};
use crate::error::kube_error_message;
use crate::parser::log_parser::{level_priority, parse_log_line, LogLevel, ParsedLog};
use crate::state::build_client;

const INITIAL_TAIL: i64 = 1000;
const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Frecuencia máxima con la que se actualiza `lastLineAt` de un stream.
const TOUCH_INTERVAL: Duration = Duration::from_secs(1);

fn next_backoff(delay: Duration) -> Duration {
    (delay * 2).min(MAX_BACKOFF)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Timestamp de kubelet (µs y texto original) del prefijo de la línea, si es válido.
fn kubelet_time(log: &ParsedLog) -> Option<(i64, String)> {
    let text = log.k8s_timestamp.as_deref()?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|d| (d.timestamp_micros(), text.to_string()))
}

// --- Estado observable ---

struct StreamStatus {
    state: StreamState,
    last_line_at: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct StatusInner {
    error: Option<String>,
    streams: BTreeMap<(String, String), StreamStatus>,
}

#[derive(Default)]
struct TargetRuntime {
    inner: Mutex<StatusInner>,
}

impl TargetRuntime {
    fn set_error(&self, error: Option<String>) {
        lock(&self.inner).error = error;
    }

    fn set_stream(&self, pod: &str, container: &str, state: StreamState, error: Option<String>) {
        let mut inner = lock(&self.inner);
        let stream = inner
            .streams
            .entry((pod.to_string(), container.to_string()))
            .or_insert(StreamStatus {
                state,
                last_line_at: None,
                error: None,
            });
        stream.state = state;
        stream.error = error;
    }

    fn touch(&self, pod: &str, container: &str) {
        if let Some(stream) = lock(&self.inner)
            .streams
            .get_mut(&(pod.to_string(), container.to_string()))
        {
            stream.last_line_at = micros_to_iso(now_micros());
        }
    }

    fn remove_stream(&self, pod: &str, container: &str) {
        lock(&self.inner)
            .streams
            .remove(&(pod.to_string(), container.to_string()));
    }

    fn remove_pod(&self, pod: &str) {
        lock(&self.inner).streams.retain(|(p, _), _| p != pod);
    }

    fn snapshot(&self, target_id: &str) -> CollectorStatus {
        let inner = lock(&self.inner);
        CollectorStatus {
            target_id: target_id.to_string(),
            state: if inner.error.is_some() {
                TargetState::Error
            } else {
                TargetState::Running
            },
            error: inner.error.clone(),
            streams: inner
                .streams
                .iter()
                .map(|((pod, container), s)| CollectorStream {
                    pod: pod.clone(),
                    container: container.clone(),
                    state: s.state,
                    last_line_at: s.last_line_at.clone(),
                    error: s.error.clone(),
                })
                .collect(),
        }
    }
}

// --- Seguidor de un contenedor ---

enum Ended {
    /// El servidor cerró el stream (contenedor terminado, pod borrado, corte del apiserver).
    Eof,
    /// Todavía no hay logs disponibles (p. ej. contenedor aún no iniciado).
    Waiting(String),
    Failed(String),
    /// El escritor se cerró: la aplicación está terminando.
    Closed,
}

fn classify(error: &kube::Error) -> Ended {
    let message = kube_error_message(error);
    match error {
        kube::Error::Api(response) if response.code == 400 => Ended::Waiting(message),
        _ => Ended::Failed(message),
    }
}

struct Follower {
    api: Api<Pod>,
    store: Arc<Store>,
    tx: WriterTx,
    runtime: Arc<TargetRuntime>,
    context: String,
    namespace: String,
    pod: String,
    container: String,
    /// El pod terminó (Succeeded/Failed): al cerrarse el stream no hay nada más que seguir.
    terminal: Arc<AtomicBool>,
    /// Filtros del target: nivel mínimo y subcadenas excluidas del mensaje.
    min_level: Option<LogLevel>,
    exclude: Vec<String>,
}

impl Follower {
    /// Filtros del colector (se aplican tras parsear, antes de encolar): las líneas sin nivel
    /// conocido (continuaciones de stack trace, texto plano) se conservan.
    fn accepts(&self, log: &ParsedLog) -> bool {
        if let Some(min) = &self.min_level {
            if log.level != LogLevel::UNKNOWN && level_priority(&log.level) < level_priority(min) {
                return false;
            }
        }
        !self.exclude.iter().any(|pattern| log.message.contains(pattern.as_str()))
    }

    fn build_row(&self, log: ParsedLog, ts_us: i64, k8s_timestamp: String) -> NewRow {
        NewRow {
            context: self.context.clone(),
            namespace: self.namespace.clone(),
            pod: self.pod.clone(),
            container: self.container.clone(),
            ts_us,
            k8s_timestamp,
            log,
        }
    }

    /// Una conexión de seguimiento: lee líneas hasta que el stream termina o falla.
    async fn follow_once(
        &self,
        params: &LogParams,
        last_us: &mut Option<i64>,
        received: &mut bool,
    ) -> Ended {
        let reader = match self.api.log_stream(&self.pod, params).await {
            Ok(reader) => reader,
            Err(e) => return classify(&e),
        };
        self.runtime
            .set_stream(&self.pod, &self.container, StreamState::Following, None);
        futures::pin_mut!(reader);

        // Al reconectar, `sinceTime` (a segundos) repite líneas ya vistas: se descartan las
        // que no superan la última posición conocida al empezar esta conexión (guardada o
        // aún sin volcar a disco).
        let floor = *last_us;
        let mut buf: Vec<u8> = Vec::new();
        let mut last_touch: Option<Instant> = None;
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => return Ended::Eof,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.trim_end_matches(['\n', '\r']);
                    if line.trim().is_empty() {
                        continue;
                    }
                    *received = true;
                    if last_touch.is_none_or(|t| t.elapsed() >= TOUCH_INTERVAL) {
                        self.runtime.touch(&self.pod, &self.container);
                        last_touch = Some(Instant::now());
                    }
                    let log = parse_log_line(line, Some(&self.pod));
                    let kubelet = kubelet_time(&log);
                    // Las líneas sin timestamp de kubelet usan la hora de llegada y nunca se
                    // descartan por posición.
                    if let Some((ts, _)) = &kubelet {
                        if floor.is_some_and(|floor| *ts <= floor) {
                            continue;
                        }
                        *last_us = Some(last_us.map_or(*ts, |previous| previous.max(*ts)));
                    }
                    if !self.accepts(&log) {
                        continue;
                    }
                    let (ts, k8s_timestamp) = kubelet.unwrap_or_else(|| {
                        let now = now_micros();
                        (now, micros_to_iso(now).unwrap_or_default())
                    });
                    let row = self.build_row(log, ts, k8s_timestamp);
                    if self.tx.send(WriterMsg::Row(Box::new(row))).await.is_err() {
                        return Ended::Closed;
                    }
                }
                Err(e) => return Ended::Failed(e.to_string()),
            }
        }
    }

    async fn run(self) {
        let last_stored = {
            let store = self.store.clone();
            let (context, namespace, pod, container) = (
                self.context.clone(),
                self.namespace.clone(),
                self.pod.clone(),
                self.container.clone(),
            );
            blocking(move || store.last_ts(&context, &namespace, &pod, &container)).await
        };
        let mut last_us = match last_stored {
            Ok(last) => last,
            Err(e) => {
                eprintln!(
                    "Historial: no se pudo leer la posición de {}/{}: {e}",
                    self.pod, self.container
                );
                None
            }
        };

        let mut delay = MIN_BACKOFF;
        loop {
            // Primera vez: las últimas líneas; después, desde la última posición conocida
            // redondeada al segundo hacia abajo (las repetidas se descartan en `follow_once`).
            let params = LogParams {
                follow: true,
                timestamps: true,
                container: Some(self.container.clone()),
                tail_lines: last_us.is_none().then_some(INITIAL_TAIL),
                since_time: last_us.and_then(|us| {
                    DateTime::<Utc>::from_timestamp_micros(us - us.rem_euclid(1_000_000))
                }),
                ..Default::default()
            };
            let mut received = false;
            match self.follow_once(&params, &mut last_us, &mut received).await {
                Ended::Closed => return,
                Ended::Eof => {
                    if self.terminal.load(Ordering::Relaxed) {
                        self.runtime.remove_stream(&self.pod, &self.container);
                        return;
                    }
                    self.runtime
                        .set_stream(&self.pod, &self.container, StreamState::Waiting, None);
                }
                Ended::Waiting(message) => self.runtime.set_stream(
                    &self.pod,
                    &self.container,
                    StreamState::Waiting,
                    Some(message),
                ),
                Ended::Failed(message) => self.runtime.set_stream(
                    &self.pod,
                    &self.container,
                    StreamState::Error,
                    Some(message),
                ),
            }

            if received {
                delay = MIN_BACKOFF;
            }
            sleep(delay).await;
            if !received {
                delay = next_backoff(delay);
            }
        }
    }
}

// --- Seguidores de un target ---

struct TargetEnv {
    target: CollectorTarget,
    api: Api<Pod>,
    store: Arc<Store>,
    tx: WriterTx,
    runtime: Arc<TargetRuntime>,
}

/// Seguidores vivos de un target. Soltarlo (al abortar la tarea del target) aborta todos.
#[derive(Default)]
struct Followers {
    tasks: JoinSet<()>,
    handles: HashMap<(String, String), AbortHandle>,
    terminal: HashMap<String, Arc<AtomicBool>>,
}

impl Followers {
    fn reap(&mut self) {
        while self.tasks.try_join_next().is_some() {}
    }

    /// Asegura un seguidor por cada contenedor del pod; devuelve el nombre del pod.
    fn ensure_pod(&mut self, env: &TargetEnv, pod: &Pod) -> Option<String> {
        let name = pod.metadata.name.clone()?;
        let is_terminal = matches!(
            pod.status.as_ref().and_then(|s| s.phase.as_deref()),
            Some("Succeeded" | "Failed")
        );
        let terminal = self.terminal.entry(name.clone()).or_default().clone();
        terminal.store(is_terminal, Ordering::Relaxed);

        let containers = pod.spec.iter().flat_map(|spec| spec.containers.iter());
        for container in containers {
            if env
                .target
                .containers
                .as_ref()
                .is_some_and(|wanted| {
                    !wanted.is_empty() && !wanted.iter().any(|w| *w == container.name)
                })
            {
                continue;
            }
            let key = (name.clone(), container.name.clone());
            match self.handles.get(&key) {
                Some(handle) if !handle.is_finished() => continue,
                // Un pod terminado cuyo seguidor ya acabó no se vuelve a leer.
                Some(_) if is_terminal => continue,
                _ => {}
            }
            let follower = Follower {
                api: env.api.clone(),
                store: env.store.clone(),
                tx: env.tx.clone(),
                runtime: env.runtime.clone(),
                context: env.target.context.clone(),
                namespace: env.target.namespace.clone(),
                pod: name.clone(),
                container: container.name.clone(),
                terminal: terminal.clone(),
                min_level: env.target.min_level,
                exclude: env.target.exclude.clone().unwrap_or_default(),
            };
            let handle = self.tasks.spawn(follower.run());
            self.handles.insert(key, handle);
        }
        Some(name)
    }

    fn remove_pod(&mut self, env: &TargetEnv, pod: &str) {
        self.handles.retain(|(p, _), handle| {
            let keep = p != pod;
            if !keep {
                handle.abort();
            }
            keep
        });
        self.terminal.remove(pod);
        env.runtime.remove_pod(pod);
    }

    /// Tras un re-list: detiene los seguidores de pods que ya no existen.
    fn retain_pods(&mut self, env: &TargetEnv, seen: &HashSet<String>) {
        let gone: Vec<String> = self
            .terminal
            .keys()
            .filter(|pod| !seen.contains(*pod))
            .cloned()
            .collect();
        for pod in gone {
            self.remove_pod(env, &pod);
        }
    }
}

async fn connect(context: &str, runtime: &TargetRuntime) -> Client {
    let mut delay = MIN_BACKOFF;
    loop {
        match build_client(context).await {
            Ok(client) => {
                runtime.set_error(None);
                return client;
            }
            Err(message) => {
                runtime.set_error(Some(message));
                sleep(delay).await;
                delay = next_backoff(delay);
            }
        }
    }
}

async fn run_target(
    target: CollectorTarget,
    store: Arc<Store>,
    tx: WriterTx,
    runtime: Arc<TargetRuntime>,
) {
    let client = connect(&target.context, &runtime).await;
    let env = TargetEnv {
        api: Api::namespaced(client, &target.namespace),
        target,
        store,
        tx,
        runtime,
    };
    let mut followers = Followers::default();

    loop {
        let mut config = watcher::Config::default();
        if let Some(selector) = env.target.label_selector.as_deref().filter(|s| !s.is_empty()) {
            config = config.labels(selector);
        }
        // `default_backoff` espera 800 ms → 60 s entre errores antes de re-listar/re-vigilar.
        let stream = watcher(env.api.clone(), config).default_backoff();
        futures::pin_mut!(stream);

        let mut seen: HashSet<String> = HashSet::new();
        while let Some(event) = stream.next().await {
            followers.reap();
            let event = match event {
                Ok(event) => event,
                Err(e) => {
                    env.runtime
                        .set_error(Some(format!("Error al vigilar los pods: {e}")));
                    continue;
                }
            };
            match event {
                // `Init` se emite antes de que el list tenga éxito: no limpia el error.
                Event::Init => {
                    seen.clear();
                    continue;
                }
                Event::InitApply(pod) => {
                    seen.extend(followers.ensure_pod(&env, &pod));
                }
                Event::InitDone => followers.retain_pods(&env, &seen),
                Event::Apply(pod) => {
                    followers.ensure_pod(&env, &pod);
                }
                Event::Delete(pod) => {
                    if let Some(name) = pod.metadata.name.as_deref() {
                        followers.remove_pod(&env, name);
                    }
                }
            }
            env.runtime.set_error(None);
        }
        sleep(MIN_BACKOFF).await;
    }
}

/// Target en ejecución; soltarlo detiene su tarea y todos sus seguidores.
pub struct RunningTarget {
    pub target: CollectorTarget,
    runtime: Arc<TargetRuntime>,
    task: JoinHandle<()>,
}

impl RunningTarget {
    /// Requiere contexto de runtime de tokio.
    pub fn start(target: CollectorTarget, store: Arc<Store>, tx: WriterTx) -> Self {
        let runtime = Arc::new(TargetRuntime::default());
        let task = tokio::spawn(run_target(target.clone(), store, tx, runtime.clone()));
        Self {
            target,
            runtime,
            task,
        }
    }

    pub fn status(&self) -> CollectorStatus {
        self.runtime.snapshot(&self.target.id)
    }
}

impl Drop for RunningTarget {
    fn drop(&mut self) {
        self.task.abort();
    }
}
