//! Escritor dedicado: agrupa filas (<= 500 o 1 s) y las inserta en una transacción
//! en el pool bloqueante. Un lote que falla se conserva y se reintenta (en orden) en el siguiente
//! volcado; mientras haya 500 o más filas pendientes deja de leer el canal de filas y los
//! seguidores esperan. `Clear` y `Shutdown` viajan por un canal propio que nunca se detiene.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, MissedTickBehavior};

use super::db::{blocking, DbResult, NewRow, Store};
use crate::error::KlvError;

const BATCH_ROWS: usize = 500;
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);
/// Canal acotado: si el disco no da abasto, los seguidores esperan en lugar de acumular memoria.
const CHANNEL_CAPACITY: usize = 4096;
const CONTROL_CAPACITY: usize = 8;

enum Control {
    /// Descarta lo pendiente y borra todos los logs.
    Clear(oneshot::Sender<DbResult<()>>),
    /// Vuelca lo pendiente (un intento) y termina.
    Shutdown(oneshot::Sender<()>),
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn scope_key(context: &str, namespace: &str, pod: &str, container: &str) -> String {
    format!("{context}\0{namespace}\0{pod}\0{container}")
}

/// Filas por contenedor (agrupando las consecutivas del mismo contenedor para no asignar una clave por fila).
fn scope_counts(rows: &[NewRow]) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut previous: Option<&NewRow> = None;
    for row in rows {
        let same = previous.is_some_and(|prev| {
            prev.context == row.context
                && prev.namespace == row.namespace
                && prev.pod == row.pod
                && prev.container == row.container
        });
        match counts.last_mut() {
            Some((_, count)) if same => *count += 1,
            _ => counts.push((scope_key(&row.context, &row.namespace, &row.pod, &row.container), 1)),
        }
        previous = Some(row);
    }
    counts
}

struct ScopePending {
    /// Filas de este contenedor aún sin guardar (en el canal o en el lote retenido).
    rows: usize,
    /// Mayor timestamp de kubelet entre ellas.
    last_ts_us: Option<i64>,
}

/// Filas enviadas al escritor que todavía no están en la base de datos, por contenedor. Permite a
/// un seguidor que arranca no releer líneas que siguen pendientes de guardar.
#[derive(Default)]
struct Pending {
    scopes: Mutex<HashMap<String, ScopePending>>,
}

impl Pending {
    fn track(&self, row: &NewRow) {
        let key = scope_key(&row.context, &row.namespace, &row.pod, &row.container);
        let mut scopes = lock(&self.scopes);
        let entry = scopes.entry(key).or_insert(ScopePending {
            rows: 0,
            last_ts_us: None,
        });
        entry.rows += 1;
        if row.from_kubelet {
            entry.last_ts_us = Some(entry.last_ts_us.map_or(row.ts_us, |ts| ts.max(row.ts_us)));
        }
    }

    /// Las filas ya están en la base de datos (o se descartaron).
    fn settle(&self, rows: &[NewRow]) {
        self.settle_counts(&scope_counts(rows));
    }

    fn settle_counts(&self, counts: &[(String, usize)]) {
        let mut scopes = lock(&self.scopes);
        for (key, count) in counts {
            let empty = scopes.get_mut(key).is_some_and(|entry| {
                entry.rows = entry.rows.saturating_sub(*count);
                entry.rows == 0
            });
            if empty {
                scopes.remove(key);
            }
        }
    }

    fn last_ts(&self, context: &str, namespace: &str, pod: &str, container: &str) -> Option<i64> {
        lock(&self.scopes)
            .get(&scope_key(context, namespace, pod, container))
            .and_then(|entry| entry.last_ts_us)
    }
}

/// Extremo de envío del escritor: filas por un canal acotado, control por otro.
#[derive(Clone)]
pub struct WriterTx {
    rows: mpsc::Sender<NewRow>,
    control: mpsc::Sender<Control>,
    pending: Arc<Pending>,
}

impl WriterTx {
    /// Encola una fila (espera si el escritor va por detrás). `false` = el escritor ya terminó.
    pub async fn send_row(&self, row: NewRow) -> bool {
        // Con el hueco reservado, registrar y enviar es síncrono: abortar la tarea mientras espera
        // no deja filas contabilizadas que nunca llegan.
        let Ok(permit) = self.rows.reserve().await else {
            return false;
        };
        self.pending.track(&row);
        permit.send(row);
        true
    }

    /// Mayor timestamp de kubelet de las filas de un contenedor que aún no están guardadas.
    pub fn pending_ts(
        &self,
        context: &str,
        namespace: &str,
        pod: &str,
        container: &str,
    ) -> Option<i64> {
        self.pending.last_ts(context, namespace, pod, container)
    }
}

pub fn spawn_writer(store: Arc<Store>) -> WriterTx {
    let (rows_tx, rows_rx) = mpsc::channel(CHANNEL_CAPACITY);
    let (control_tx, control_rx) = mpsc::channel(CONTROL_CAPACITY);
    let pending = Arc::new(Pending::default());
    tokio::spawn(run(store, rows_rx, control_rx, pending.clone()));
    WriterTx {
        rows: rows_tx,
        control: control_tx,
        pending,
    }
}

/// Inserta el lote. Si falla, las filas vuelven a `batch` (mismo orden) para el siguiente intento.
async fn flush(store: &Arc<Store>, pending: &Pending, batch: &mut Vec<NewRow>) {
    if batch.is_empty() {
        return;
    }
    let rows = std::mem::take(batch);
    // Por si la tarea bloqueante entra en pánico y se pierden las filas: aun así dejan de estar pendientes.
    let counts = scope_counts(&rows);
    let store = store.clone();
    let outcome = blocking(move || {
        let result = store.insert_batch(&rows);
        Ok((result, rows))
    })
    .await;
    match outcome {
        Ok((Ok(()), _)) => pending.settle_counts(&counts),
        Ok((Err(e), rows)) => {
            eprintln!(
                "Historial: no se pudo guardar un lote de {} logs (se reintentará): {e}",
                rows.len()
            );
            *batch = rows;
        }
        Err(e) => {
            eprintln!("Historial: se perdió un lote de logs por un fallo interno: {e}");
            pending.settle_counts(&counts);
        }
    }
}

async fn run(
    store: Arc<Store>,
    mut rows: mpsc::Receiver<NewRow>,
    mut control: mpsc::Receiver<Control>,
    pending: Arc<Pending>,
) {
    let mut batch: Vec<NewRow> = Vec::with_capacity(BATCH_ROWS);
    let mut ticker = interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            biased;
            msg = control.recv() => match msg {
                None => {
                    flush(&store, &pending, &mut batch).await;
                    return;
                }
                Some(Control::Clear(reply)) => {
                    // Se liquida exactamente lo descartado: una fila enviada durante el vaciado sigue contabilizada.
                    pending.settle(&batch);
                    batch.clear();
                    let mut drained = Vec::new();
                    while let Ok(row) = rows.try_recv() {
                        drained.push(row);
                    }
                    pending.settle(&drained);
                    let store = store.clone();
                    let _ = reply.send(blocking(move || store.clear()).await);
                }
                Some(Control::Shutdown(reply)) => {
                    while let Ok(row) = rows.try_recv() {
                        batch.push(row);
                    }
                    flush(&store, &pending, &mut batch).await;
                    let _ = reply.send(());
                    return;
                }
            },
            // Con un lote retenido de 500 filas o más no se lee: los seguidores esperan.
            row = rows.recv(), if batch.len() < BATCH_ROWS => match row {
                None => {
                    flush(&store, &pending, &mut batch).await;
                    return;
                }
                Some(row) => {
                    batch.push(row);
                    if batch.len() >= BATCH_ROWS {
                        flush(&store, &pending, &mut batch).await;
                    }
                }
            },
            _ = ticker.tick() => flush(&store, &pending, &mut batch).await,
        }
    }
}

fn unavailable() -> KlvError {
    KlvError::new("El escritor del historial no está disponible")
}

/// Pide al escritor vaciar la base y espera el resultado.
pub async fn clear(tx: &WriterTx) -> DbResult<()> {
    let (reply, wait) = oneshot::channel();
    tx.control
        .send(Control::Clear(reply))
        .await
        .map_err(|_| unavailable())?;
    wait.await.map_err(|_| unavailable())?
}

/// Pide al escritor volcar lo pendiente (un intento) y terminar.
pub async fn shutdown(tx: &WriterTx) {
    let (reply, wait) = oneshot::channel();
    if tx.control.send(Control::Shutdown(reply)).await.is_ok() {
        let _ = wait.await;
    }
}
