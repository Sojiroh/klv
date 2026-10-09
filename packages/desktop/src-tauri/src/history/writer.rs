//! Escritor dedicado: agrupa filas (<= 500 o 1 s) y las inserta en una transacción
//! en el pool bloqueante.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, MissedTickBehavior};

use super::db::{blocking, DbResult, NewRow, Store};
use crate::error::KlvError;

const BATCH_ROWS: usize = 500;
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);
/// Canal acotado: si el disco no da abasto, los seguidores esperan en lugar de acumular memoria.
const CHANNEL_CAPACITY: usize = 4096;

pub enum WriterMsg {
    Row(Box<NewRow>),
    /// Descarta lo pendiente y borra todos los logs.
    Clear(oneshot::Sender<DbResult<()>>),
    /// Vuelca lo pendiente y termina.
    Shutdown(oneshot::Sender<()>),
}

pub type WriterTx = mpsc::Sender<WriterMsg>;

pub fn spawn_writer(store: Arc<Store>) -> WriterTx {
    let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
    tokio::spawn(run(store, rx));
    tx
}

async fn flush(store: &Arc<Store>, batch: &mut Vec<NewRow>) {
    if batch.is_empty() {
        return;
    }
    let rows = std::mem::take(batch);
    let store = store.clone();
    if let Err(e) = blocking(move || store.insert_batch(&rows)).await {
        eprintln!("Historial: no se pudo guardar un lote de logs: {e}");
    }
}

async fn run(store: Arc<Store>, mut rx: mpsc::Receiver<WriterMsg>) {
    let mut batch: Vec<NewRow> = Vec::with_capacity(BATCH_ROWS);
    let mut ticker = interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                None => {
                    flush(&store, &mut batch).await;
                    return;
                }
                Some(WriterMsg::Row(row)) => {
                    batch.push(*row);
                    if batch.len() >= BATCH_ROWS {
                        flush(&store, &mut batch).await;
                    }
                }
                Some(WriterMsg::Clear(reply)) => {
                    batch.clear();
                    let store = store.clone();
                    let _ = reply.send(blocking(move || store.clear()).await);
                }
                Some(WriterMsg::Shutdown(reply)) => {
                    flush(&store, &mut batch).await;
                    let _ = reply.send(());
                    return;
                }
            },
            _ = ticker.tick() => flush(&store, &mut batch).await,
        }
    }
}

/// Pide al escritor vaciar la base y espera el resultado.
pub async fn clear(tx: &WriterTx) -> DbResult<()> {
    let (reply, wait) = oneshot::channel();
    tx.send(WriterMsg::Clear(reply))
        .await
        .map_err(|_| KlvError::new("El escritor del historial no está disponible"))?;
    wait.await
        .map_err(|_| KlvError::new("El escritor del historial no está disponible"))?
}

/// Pide al escritor volcar lo pendiente y terminar.
pub async fn shutdown(tx: &WriterTx) {
    let (reply, wait) = oneshot::channel();
    if tx.send(WriterMsg::Shutdown(reply)).await.is_ok() {
        let _ = wait.await;
    }
}
