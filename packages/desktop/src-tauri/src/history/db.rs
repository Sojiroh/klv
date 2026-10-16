//! Almacén del historial: DuckDB (filas aún no exportadas y metadatos) + segmentos Parquet por
//! hora (bloqueante: llamar siempre desde `spawn_blocking`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, SecondsFormat, Utc};
use duckdb::{params, Connection, OptionalExt};

use super::types::{HistoryStats, RetentionSettings};
use crate::error::KlvError;
use crate::parser::log_parser::{LogLevel, ParsedLog};

pub type DbResult<T> = Result<T, KlvError>;

pub fn db_err(e: duckdb::Error) -> KlvError {
    KlvError::new(format!("Error en la base de datos del historial: {e}"))
}

/// Ejecuta trabajo de DuckDB/disco en el pool bloqueante de tokio.
pub async fn blocking<T, F>(work: F) -> DbResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> DbResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| KlvError::internal(e.to_string()))?
}

const MICROS_PER_HOUR: i64 = 3_600_000_000;
const MICROS_PER_DAY: i64 = 86_400_000_000;
/// Margen para las líneas tardías de la hora en curso antes de exportar su segmento.
const ROLLOVER_GRACE: i64 = 120_000_000;
const MB: i64 = 1024 * 1024;

/// Columnas en el orden del esquema (idéntico en `current` y en cada archivo Parquet).
pub const COLUMNS: &str = "id, ts_us, context, namespace, pod, container, k8s_timestamp, level, \
    service, env, version, trace_id, span_id, caller, message, error, stack_trace, raw";

// `ts_us` son microsegundos desde la época (timestamp de kubelet; si la línea no lo trae, la
// hora de llegada). No hay índice de deduplicación: el colector descarta las relecturas.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS current (
    id BIGINT NOT NULL,
    ts_us BIGINT NOT NULL,
    context VARCHAR NOT NULL,
    namespace VARCHAR NOT NULL,
    pod VARCHAR NOT NULL,
    container VARCHAR NOT NULL,
    k8s_timestamp VARCHAR NOT NULL,
    level VARCHAR NOT NULL,
    service VARCHAR,
    env VARCHAR,
    version VARCHAR,
    trace_id VARCHAR,
    span_id VARCHAR,
    caller VARCHAR,
    message VARCHAR NOT NULL,
    error VARCHAR,
    stack_trace VARCHAR,
    raw VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
    id BIGINT PRIMARY KEY,
    bucket_us BIGINT,
    file VARCHAR,
    rows BIGINT,
    bytes BIGINT,
    min_ts_us BIGINT,
    max_ts_us BIGINT,
    min_id BIGINT,
    max_id BIGINT
);
CREATE TABLE IF NOT EXISTS streams (
    context VARCHAR,
    namespace VARCHAR,
    pod VARCHAR,
    container VARCHAR,
    last_ts_us BIGINT,
    PRIMARY KEY (context, namespace, pod, container)
);
";

/// Línea ya parseada lista para insertar.
pub struct NewRow {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub ts_us: i64,
    /// Timestamp de kubelet original (o el de llegada si la línea no lo traía).
    pub k8s_timestamp: String,
    pub log: ParsedLog,
}

pub fn level_str(level: LogLevel) -> &'static str {
    match level {
        LogLevel::TRACE => "TRACE",
        LogLevel::DEBUG => "DEBUG",
        LogLevel::INFO => "INFO",
        LogLevel::WARN => "WARN",
        LogLevel::ERROR => "ERROR",
        LogLevel::FATAL => "FATAL",
        LogLevel::UNKNOWN => "UNKNOWN",
    }
}

pub fn now_micros() -> i64 {
    Utc::now().timestamp_micros()
}

/// ISO-8601 UTC con milisegundos (como `Date.prototype.toISOString`).
pub fn micros_to_iso(micros: i64) -> Option<String> {
    DateTime::from_timestamp_micros(micros).map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Literal SQL de texto entre comillas simples.
pub fn sql_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn remove_file(path: &Path) {
    if let Err(e) = fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("Historial: no se pudo borrar {}: {e}", path.display());
        }
    }
}

/// Segmentos (id, archivo) que devuelve `sql`.
fn segment_files(conn: &Connection, sql: &str) -> DbResult<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(sql).map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

/// Recuperación tras un cierre abrupto: descarta `.tmp` y Parquet sin metadatos (sus filas
/// siguen en `current`) y los metadatos de archivos que ya no existen.
fn recover(conn: &Connection, segments_dir: &Path) -> DbResult<()> {
    let segments = segment_files(conn, "SELECT id, file FROM segments")?;
    let known: HashSet<&str> = segments.iter().map(|(_, file)| file.as_str()).collect();

    for entry in fs::read_dir(segments_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let orphan = name.ends_with(".tmp") || (name.ends_with(".parquet") && !known.contains(name.as_str()));
        if orphan {
            remove_file(&entry.path());
        }
    }
    for (id, file) in &segments {
        if !segments_dir.join(file).exists() {
            eprintln!("Historial: falta el segmento {file}; se descartan sus metadatos");
            conn.execute("DELETE FROM segments WHERE id = ?", params![id])
                .map_err(db_err)?;
        }
    }
    Ok(())
}

fn query_i64(conn: &Connection, sql: &str) -> DbResult<i64> {
    conn.query_row(sql, [], |r| r.get::<_, i64>(0)).map_err(db_err)
}

pub struct Store {
    db_path: PathBuf,
    segments_dir: PathBuf,
    /// Única conexión de escritura (las escrituras se serializan con su mutex).
    writer: Mutex<Connection>,
    /// Plantilla para `try_clone`: DuckDB no permite abrir el mismo archivo dos veces.
    reader: Mutex<Connection>,
    next_id: AtomicI64,
    next_segment: AtomicI64,
    /// Serializa rollover, retención y borrado total.
    maintenance: Mutex<()>,
}

impl Store {
    /// Abre `<dir>/history.duckdb` (una vez por proceso) y prepara `<dir>/segments`.
    pub fn open(dir: &Path) -> DbResult<Self> {
        let segments_dir = dir.join("segments");
        fs::create_dir_all(&segments_dir)
            .map_err(|e| KlvError::new(format!("{}: {e}", segments_dir.display())))?;
        let db_path = dir.join("history.duckdb");
        let conn = Connection::open(&db_path).map_err(db_err)?;
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(4);
        conn.execute_batch(&format!(
            "SET memory_limit = '1GB'; SET threads = {threads}; {SCHEMA}"
        ))
        .map_err(db_err)?;
        recover(&conn, &segments_dir)?;

        let next_id = query_i64(
            &conn,
            "SELECT greatest(
                coalesce((SELECT max(id) FROM current), 0),
                coalesce((SELECT max(max_id) FROM segments), 0)
            ) + 1",
        )?;
        let next_segment = query_i64(&conn, "SELECT coalesce(max(id), 0) + 1 FROM segments")?;
        let reader = conn.try_clone().map_err(db_err)?;
        Ok(Self {
            db_path,
            segments_dir,
            writer: Mutex::new(conn),
            reader: Mutex::new(reader),
            next_id: AtomicI64::new(next_id),
            next_segment: AtomicI64::new(next_segment),
            maintenance: Mutex::new(()),
        })
    }

    /// `<dir>/history.duckdb`.
    pub fn path(&self) -> &Path {
        &self.db_path
    }

    pub fn segments_dir(&self) -> &Path {
        &self.segments_dir
    }

    fn writer(&self) -> MutexGuard<'_, Connection> {
        lock(&self.writer)
    }

    /// Conexión de lectura independiente (clon de la conexión abierta).
    pub fn read_conn(&self) -> DbResult<Connection> {
        lock(&self.reader).try_clone().map_err(db_err)
    }

    /// Inserta el lote en `current` y actualiza `streams`, todo en una transacción.
    pub fn insert_batch(&self, rows: &[NewRow]) -> DbResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut conn = self.writer();
        let first_id = self.next_id.fetch_add(rows.len() as i64, Ordering::Relaxed);
        let tx = conn.transaction().map_err(db_err)?;
        {
            let mut appender = tx.appender("current").map_err(db_err)?;
            for (offset, row) in rows.iter().enumerate() {
                let log = &row.log;
                let id = first_id + offset as i64;
                let level = level_str(log.level);
                appender
                    .append_row(params![
                        id,
                        row.ts_us,
                        row.context,
                        row.namespace,
                        row.pod,
                        row.container,
                        row.k8s_timestamp,
                        level,
                        log.service,
                        log.env,
                        log.version,
                        log.trace_id,
                        log.span_id,
                        log.caller,
                        log.message,
                        log.error,
                        log.stack_trace,
                        log.raw,
                    ])
                    .map_err(db_err)?;
            }
            appender.flush().map_err(db_err)?;
        }

        let mut latest: HashMap<(&str, &str, &str, &str), i64> = HashMap::new();
        for row in rows {
            let key = (
                row.context.as_str(),
                row.namespace.as_str(),
                row.pod.as_str(),
                row.container.as_str(),
            );
            let slot = latest.entry(key).or_insert(row.ts_us);
            *slot = (*slot).max(row.ts_us);
        }
        {
            let mut upsert = tx
                .prepare(
                    "INSERT INTO streams (context, namespace, pod, container, last_ts_us)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (context, namespace, pod, container)
                     DO UPDATE SET last_ts_us = greatest(last_ts_us, excluded.last_ts_us)",
                )
                .map_err(db_err)?;
            for ((context, namespace, pod, container), ts_us) in latest {
                upsert
                    .execute(params![context, namespace, pod, container, ts_us])
                    .map_err(db_err)?;
            }
        }
        tx.commit().map_err(db_err)
    }

    /// Último timestamp (µs) visto de un contenedor, para reanudar con `sinceTime`.
    pub fn last_ts(
        &self,
        context: &str,
        namespace: &str,
        pod: &str,
        container: &str,
    ) -> DbResult<Option<i64>> {
        self.read_conn()?
            .query_row(
                "SELECT last_ts_us FROM streams
                 WHERE context = ? AND namespace = ? AND pod = ? AND container = ?",
                params![context, namespace, pod, container],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(db_err)
    }

    pub fn stats(&self) -> DbResult<HistoryStats> {
        let conn = self.read_conn()?;
        let (rows, oldest, newest) = conn
            .query_row(
                "SELECT
                    CAST(coalesce((SELECT sum(rows) FROM segments), 0) AS BIGINT)
                        + (SELECT count(*) FROM current),
                    least((SELECT min(min_ts_us) FROM segments), (SELECT min(ts_us) FROM current)),
                    greatest((SELECT max(max_ts_us) FROM segments), (SELECT max(ts_us) FROM current))",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .map_err(db_err)?;
        Ok(HistoryStats {
            rows,
            size_bytes: self.size_bytes(&conn)?,
            oldest: oldest.and_then(micros_to_iso),
            newest: newest.and_then(micros_to_iso),
        })
    }

    /// Segmentos Parquet + archivo DuckDB + su WAL.
    fn size_bytes(&self, conn: &Connection) -> DbResult<i64> {
        let segments = query_i64(conn, "SELECT CAST(coalesce(sum(bytes), 0) AS BIGINT) FROM segments")?;
        let mut wal = self.db_path.clone().into_os_string();
        wal.push(".wal");
        let file_len = |path: &Path| fs::metadata(path).map_or(0, |m| m.len() as i64);
        Ok(segments + file_len(&self.db_path) + file_len(Path::new(&wal)))
    }

    /// `CHECKPOINT` consume el WAL; si otra transacción lo impide se reintenta en la próxima pasada.
    fn checkpoint(&self) {
        if let Err(e) = self.writer().execute_batch("CHECKPOINT") {
            eprintln!("Historial: no se pudo hacer CHECKPOINT: {e}");
        }
    }

    /// Borra todos los logs (la configuración se conserva).
    pub fn clear(&self) -> DbResult<()> {
        let _guard = lock(&self.maintenance);
        let reader = self.read_conn()?;
        for (_, file) in segment_files(&reader, "SELECT id, file FROM segments")? {
            remove_file(&self.segments_dir.join(file));
        }
        {
            let mut conn = self.writer();
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute_batch("DELETE FROM segments; DELETE FROM current; DELETE FROM streams;")
                .map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        self.checkpoint();
        Ok(())
    }

    /// Exporta a Parquet cada hora completa (y cerrada hace más de 2 minutos) de `current`.
    pub fn rollover(&self) -> DbResult<()> {
        let _guard = lock(&self.maintenance);
        self.rollover_locked()
    }

    fn rollover_locked(&self) -> DbResult<()> {
        let reader = self.read_conn()?;
        let limit = now_micros() - ROLLOVER_GRACE;
        let buckets = {
            let mut stmt = reader
                .prepare(&format!(
                    "SELECT DISTINCT ts_us - ts_us % {MICROS_PER_HOUR} AS bucket FROM current
                     WHERE ts_us - ts_us % {MICROS_PER_HOUR} + {MICROS_PER_HOUR} <= {limit}
                     ORDER BY bucket"
                ))
                .map_err(db_err)?;
            let buckets = stmt
                .query_map([], |r| r.get::<_, i64>(0))
                .map_err(db_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err)?;
            buckets
        };
        let result = buckets
            .into_iter()
            .try_for_each(|bucket| self.export_bucket(&reader, bucket));
        // Aunque falle una hora, se consume el WAL de lo que sí se haya exportado.
        drop(reader);
        self.checkpoint();
        result
    }

    /// Exporta las filas de `current` de una hora (hasta el `id` máximo actual) a un segmento.
    fn export_bucket(&self, reader: &Connection, bucket: i64) -> DbResult<()> {
        let max_id = reader
            .query_row(
                &format!(
                    "SELECT max(id) FROM current WHERE ts_us >= {bucket} AND ts_us < {}",
                    bucket + MICROS_PER_HOUR
                ),
                [],
                |r| r.get::<_, Option<i64>>(0),
            )
            .map_err(db_err)?;
        let Some(max_id) = max_id else {
            return Ok(());
        };
        let predicate = format!(
            "ts_us >= {bucket} AND ts_us < {} AND id <= {max_id}",
            bucket + MICROS_PER_HOUR
        );

        let hour = DateTime::from_timestamp_micros(bucket)
            .ok_or_else(|| KlvError::internal(format!("hora fuera de rango: {bucket}")))?
            .format("%Y%m%dT%H");
        let segment_id = self.next_segment.fetch_add(1, Ordering::Relaxed);
        let name = format!("{hour}-{segment_id}.parquet");
        let path = self.segments_dir.join(&name);
        let tmp = self.segments_dir.join(format!("{name}.tmp"));

        let exported = (|| {
            reader
                .execute_batch(&format!(
                    "COPY (SELECT {COLUMNS} FROM current WHERE {predicate} ORDER BY ts_us, id)
                     TO {} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)",
                    sql_quote(&tmp.to_string_lossy())
                ))
                .map_err(db_err)?;
            reader
                .query_row(
                    &format!(
                        "SELECT count(*), min(ts_us), max(ts_us), min(id), max(id)
                         FROM read_parquet({})",
                        sql_quote(&tmp.to_string_lossy())
                    ),
                    [],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, Option<i64>>(1)?,
                            r.get::<_, Option<i64>>(2)?,
                            r.get::<_, Option<i64>>(3)?,
                            r.get::<_, Option<i64>>(4)?,
                        ))
                    },
                )
                .map_err(db_err)
        })();
        let (rows, min_ts, max_ts, min_id, last_id) = match exported {
            Ok(stats) => stats,
            Err(e) => {
                remove_file(&tmp);
                return Err(e);
            }
        };
        let (Some(min_ts), Some(max_ts), Some(min_id), Some(last_id)) = (min_ts, max_ts, min_id, last_id)
        else {
            remove_file(&tmp);
            return Ok(());
        };

        let bytes = fs::metadata(&tmp).map(|m| m.len() as i64);
        let published = bytes
            .and_then(|bytes| fs::rename(&tmp, &path).map(|()| bytes))
            .map_err(KlvError::from);
        let bytes = match published {
            Ok(bytes) => bytes,
            Err(e) => {
                remove_file(&tmp);
                return Err(e);
            }
        };

        let committed = (|| {
            let mut conn = self.writer();
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute(
                "INSERT INTO segments
                    (id, bucket_us, file, rows, bytes, min_ts_us, max_ts_us, min_id, max_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![segment_id, bucket, name, rows, bytes, min_ts, max_ts, min_id, last_id],
            )
            .map_err(db_err)?;
            tx.execute_batch(&format!("DELETE FROM current WHERE {predicate}"))
                .map_err(db_err)?;
            tx.commit().map_err(db_err)
        })();
        if committed.is_err() {
            // Sin metadatos el archivo sería huérfano; las filas siguen en `current`.
            remove_file(&path);
        }
        committed
    }

    /// Borra un segmento: primero el archivo y después sus metadatos.
    fn delete_segment(&self, id: i64, file: &str) -> DbResult<()> {
        remove_file(&self.segments_dir.join(file));
        self.writer()
            .execute("DELETE FROM segments WHERE id = ?", params![id])
            .map_err(db_err)?;
        Ok(())
    }

    /// Retención a nivel de archivo: borra los segmentos expirados y, si el almacén supera el
    /// tamaño máximo, los más antiguos. No toca el contenido de ningún Parquet.
    pub fn prune(&self, retention: &RetentionSettings) -> DbResult<()> {
        let _guard = lock(&self.maintenance);
        let reader = self.read_conn()?;

        let cutoff = now_micros() - retention.max_age_days.saturating_mul(MICROS_PER_DAY);
        for (id, file) in segment_files(
            &reader,
            &format!("SELECT id, file FROM segments WHERE max_ts_us < {cutoff} ORDER BY bucket_us, id"),
        )? {
            self.delete_segment(id, &file)?;
        }
        self.writer()
            .execute("DELETE FROM current WHERE ts_us < ?", params![cutoff])
            .map_err(db_err)?;

        let limit = retention.max_size_mb.saturating_mul(MB);
        while self.size_bytes(&reader)? > limit {
            let oldest = segment_files(
                &reader,
                "SELECT id, file FROM segments ORDER BY bucket_us, id LIMIT 1",
            )?;
            let Some((id, file)) = oldest.into_iter().next() else {
                break;
            };
            self.delete_segment(id, &file)?;
        }
        drop(reader);
        self.rollover_locked()
    }
}
