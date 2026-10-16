//! Almacén SQLite del historial (bloqueante: llamar siempre desde `spawn_blocking`).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::types::{
    CollectorTarget, HistoryConfig, HistoryStats, RetentionSettings, DEFAULT_RETENTION,
};
use crate::error::KlvError;
use crate::parser::log_parser::{LogLevel, ParsedLog};
use crate::query::{search_text, QueryTarget};

pub type DbResult<T> = Result<T, KlvError>;

pub fn db_err(e: rusqlite::Error) -> KlvError {
    KlvError::new(format!("Error en la base de datos del historial: {e}"))
}

/// Ejecuta trabajo SQLite en el pool bloqueante de tokio.
pub async fn blocking<T, F>(work: F) -> DbResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> DbResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| KlvError::internal(e.to_string()))?
}

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const PRUNE_CHUNK: i64 = 5_000;
const VACUUM_CHUNK: i64 = 2_000;
const SIZE_PRUNE_ROUNDS: usize = 3;
const MICROS_PER_DAY: i64 = 86_400_000_000;
const MB: i64 = 1024 * 1024;

const CONFIG_SCHEMA: &str = "
CREATE TABLE targets (
    position INTEGER NOT NULL,
    id TEXT PRIMARY KEY,
    context TEXT NOT NULL,
    namespace TEXT NOT NULL,
    container TEXT,
    label_selector TEXT,
    enabled INTEGER NOT NULL
);
CREATE TABLE retention (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_age_days INTEGER NOT NULL,
    max_size_mb INTEGER NOT NULL
);
";

// `ts` y los tiempos del esquema son microsegundos desde la época (timestamp de kubelet).
// La unicidad (contexto, namespace, pod, container, ts, hash de la línea) deduplica las
// relecturas tras una reconexión; `raw` incluye el timestamp con nanosegundos.
const LOGS_SCHEMA: &str = "
CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    context TEXT NOT NULL,
    namespace TEXT NOT NULL,
    pod TEXT NOT NULL,
    container TEXT NOT NULL,
    ts INTEGER NOT NULL,
    line_hash INTEGER NOT NULL,
    k8s_timestamp TEXT NOT NULL,
    timestamp TEXT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    service TEXT,
    trace_id TEXT,
    span_id TEXT,
    caller TEXT,
    error TEXT,
    stack_trace TEXT,
    is_json INTEGER NOT NULL,
    raw TEXT NOT NULL,
    extra TEXT NOT NULL
);
CREATE UNIQUE INDEX logs_dedup ON logs (context, namespace, pod, container, ts, line_hash);
CREATE INDEX logs_ns_container_ts ON logs (namespace, container, ts);
CREATE INDEX logs_ns_pod_ts ON logs (namespace, pod, ts);
CREATE INDEX logs_ts ON logs (ts, id);
CREATE VIRTUAL TABLE logs_fts USING fts5(
    search, content = '', contentless_delete = 1, tokenize = 'trigram'
);
CREATE TRIGGER logs_fts_delete AFTER DELETE ON logs
BEGIN
    DELETE FROM logs_fts WHERE rowid = old.id;
END;
";

/// `user_version = índice + 1`; añadir migraciones al final.
const MIGRATIONS: &[&[&str]] = &[
    &[CONFIG_SCHEMA, LOGS_SCHEMA],
    &[
        "ALTER TABLE logs ADD COLUMN env TEXT",
        "ALTER TABLE logs ADD COLUMN version TEXT",
    ],
];

const INSERT_LOG: &str = "
INSERT OR IGNORE INTO logs (
    context, namespace, pod, container, ts, line_hash, k8s_timestamp, timestamp, level,
    message, service, env, version, trace_id, span_id, caller, error, stack_trace, is_json, raw, extra
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)";

/// Línea ya parseada lista para insertar.
pub struct NewRow {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub ts: i64,
    pub line_hash: i64,
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

/// Texto indexado en FTS: exactamente el que evalúa `matches_query` para los nodos `text`
/// (`query.rs::search_text`): message, error, stack_trace, service, env, version, trace_id,
/// span_id, caller, pod, container, namespace y después el JSON de `extra`.
fn indexed_text(row: &NewRow) -> String {
    search_text(&QueryTarget {
        log: &row.log,
        namespace: Some(&row.namespace),
        container: Some(&row.container),
    })
}

fn user_version(conn: &Connection) -> DbResult<usize> {
    let version = conn
        .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .map_err(db_err)?;
    Ok(usize::try_from(version).unwrap_or(0))
}

fn migrate(conn: &mut Connection) -> DbResult<()> {
    let current = user_version(conn)?;
    if current > MIGRATIONS.len() {
        return Err(KlvError::new(
            "La base de datos del historial pertenece a una versión más reciente de KLV",
        ));
    }
    for (index, steps) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction().map_err(db_err)?;
        for step in *steps {
            tx.execute_batch(step).map_err(db_err)?;
        }
        tx.execute_batch(&format!("PRAGMA user_version = {}", index + 1))
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
    }
    Ok(())
}

fn page_bytes(conn: &Connection, count_pragma: &str) -> DbResult<i64> {
    let pages = conn
        .query_row(&format!("PRAGMA {count_pragma}"), [], |r| r.get::<_, i64>(0))
        .map_err(db_err)?;
    let page_size = conn
        .query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0))
        .map_err(db_err)?;
    Ok(pages.saturating_mul(page_size))
}

/// Tamaño del archivo principal (incluye páginas libres).
fn size_bytes(conn: &Connection) -> DbResult<i64> {
    page_bytes(conn, "page_count")
}

fn free_bytes(conn: &Connection) -> DbResult<i64> {
    page_bytes(conn, "freelist_count")
}

fn load_retention(conn: &Connection) -> DbResult<RetentionSettings> {
    let stored = conn
        .query_row(
            "SELECT max_age_days, max_size_mb FROM retention WHERE id = 1",
            [],
            |r| {
                Ok(RetentionSettings {
                    max_age_days: r.get(0)?,
                    max_size_mb: r.get(1)?,
                })
            },
        )
        .optional()
        .map_err(db_err)?;
    Ok(stored.unwrap_or(DEFAULT_RETENTION))
}

pub struct Store {
    path: PathBuf,
    writer: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> DbResult<Self> {
        let mut conn = Connection::open(path).map_err(db_err)?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(db_err)?;
        // `auto_vacuum` solo aplica a una base nueva y debe fijarse antes de crear tablas.
        conn.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA analysis_limit = 400;",
        )
        .map_err(db_err)?;
        migrate(&mut conn)?;
        Ok(Self {
            path: path.to_path_buf(),
            writer: Mutex::new(conn),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn writer(&self) -> MutexGuard<'_, Connection> {
        self.writer.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Conexión de solo lectura independiente (WAL permite leer mientras se escribe).
    pub fn read_conn(&self) -> DbResult<Connection> {
        let conn = Connection::open(&self.path).map_err(db_err)?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(db_err)?;
        conn.execute_batch("PRAGMA query_only = 1;").map_err(db_err)?;
        Ok(conn)
    }

    pub fn load_config(&self) -> DbResult<HistoryConfig> {
        let conn = self.read_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, context, namespace, container, label_selector, enabled
                 FROM targets ORDER BY position",
            )
            .map_err(db_err)?;
        let targets = stmt
            .query_map([], |r| {
                Ok(CollectorTarget {
                    id: r.get(0)?,
                    context: r.get(1)?,
                    namespace: r.get(2)?,
                    container: r.get(3)?,
                    label_selector: r.get(4)?,
                    enabled: r.get(5)?,
                })
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(HistoryConfig {
            targets,
            retention: load_retention(&conn)?,
        })
    }

    pub fn save_config(&self, config: &HistoryConfig) -> DbResult<()> {
        let mut conn = self.writer();
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute("DELETE FROM targets", []).map_err(db_err)?;
        for (position, target) in config.targets.iter().enumerate() {
            tx.execute(
                "INSERT INTO targets
                    (position, id, context, namespace, container, label_selector, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    position as i64,
                    target.id,
                    target.context,
                    target.namespace,
                    target.container,
                    target.label_selector,
                    target.enabled,
                ],
            )
            .map_err(db_err)?;
        }
        tx.execute(
            "INSERT INTO retention (id, max_age_days, max_size_mb) VALUES (1, ?1, ?2)
             ON CONFLICT (id) DO UPDATE SET
                max_age_days = excluded.max_age_days, max_size_mb = excluded.max_size_mb",
            params![config.retention.max_age_days, config.retention.max_size_mb],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)
    }

    pub fn insert_batch(&self, rows: &[NewRow]) -> DbResult<()> {
        let mut conn = self.writer();
        let tx = conn.transaction().map_err(db_err)?;
        {
            let mut insert = tx.prepare_cached(INSERT_LOG).map_err(db_err)?;
            let mut index = tx
                .prepare_cached("INSERT INTO logs_fts (rowid, search) VALUES (?1, ?2)")
                .map_err(db_err)?;
            for row in rows {
                let log = &row.log;
                let extra =
                    serde_json::to_string(&log.extra).unwrap_or_else(|_| String::from("{}"));
                let inserted = insert
                    .execute(params![
                        row.context,
                        row.namespace,
                        row.pod,
                        row.container,
                        row.ts,
                        row.line_hash,
                        row.k8s_timestamp,
                        log.timestamp,
                        level_str(log.level),
                        log.message,
                        log.service,
                        log.env,
                        log.version,
                        log.trace_id,
                        log.span_id,
                        log.caller,
                        log.error,
                        log.stack_trace,
                        log.is_json,
                        log.raw,
                        extra,
                    ])
                    .map_err(db_err)?;
                // 0 = duplicado ignorado por la restricción de unicidad
                if inserted == 1 {
                    index
                        .execute(params![tx.last_insert_rowid(), indexed_text(row)])
                        .map_err(db_err)?;
                }
            }
        }
        tx.commit().map_err(db_err)
    }

    /// Último timestamp (µs) almacenado de un contenedor, para reanudar con `sinceTime`.
    pub fn last_ts(
        &self,
        context: &str,
        namespace: &str,
        pod: &str,
        container: &str,
    ) -> DbResult<Option<i64>> {
        self.read_conn()?
            .query_row(
                "SELECT MAX(ts) FROM logs
                 WHERE context = ?1 AND namespace = ?2 AND pod = ?3 AND container = ?4",
                params![context, namespace, pod, container],
                |r| r.get::<_, Option<i64>>(0),
            )
            .map_err(db_err)
    }

    pub fn stats(&self) -> DbResult<HistoryStats> {
        let conn = self.read_conn()?;
        let (rows, oldest, newest) = conn
            .query_row("SELECT COUNT(*), MIN(ts), MAX(ts) FROM logs", [], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })
            .map_err(db_err)?;
        Ok(HistoryStats {
            rows,
            size_bytes: size_bytes(&conn)?,
            oldest: oldest.and_then(micros_to_iso),
            newest: newest.and_then(micros_to_iso),
        })
    }

    /// Borra todos los logs (la configuración se conserva): recrear las tablas es mucho más
    /// rápido que borrar fila a fila (y su índice FTS).
    pub fn clear(&self) -> DbResult<()> {
        {
            let mut conn = self.writer();
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute_batch("DROP TABLE IF EXISTS logs_fts; DROP TABLE IF EXISTS logs;")
                .map_err(db_err)?;
            tx.execute_batch(LOGS_SCHEMA).map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        self.reclaim()
    }

    /// Libera las páginas libres por tandas (sin retener el bloqueo de escritura) y trunca el WAL.
    fn reclaim(&self) -> DbResult<()> {
        loop {
            let conn = self.writer();
            if free_bytes(&conn)? == 0 {
                break;
            }
            // Cada `step` libera una página: hay que recorrer todas las filas del pragma.
            let mut stmt = conn
                .prepare(&format!("PRAGMA incremental_vacuum({VACUUM_CHUNK})"))
                .map_err(db_err)?;
            let mut rows = stmt.query([]).map_err(db_err)?;
            while rows.next().map_err(db_err)?.is_some() {}
        }
        self.writer()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(db_err)
    }

    /// Ejecuta `delete_sql` por tandas de `PRUNE_CHUNK` filas (el tamaño de tanda es el último
    /// parámetro, tras `args`) hasta que no borre nada o se alcance `max_rows`, soltando el
    /// bloqueo de escritura entre tandas. Devuelve las filas borradas.
    fn delete_in_chunks(
        &self,
        delete_sql: &str,
        args: &[i64],
        max_rows: Option<i64>,
    ) -> DbResult<i64> {
        let mut total = 0;
        loop {
            let chunk = match max_rows {
                Some(max) => PRUNE_CHUNK.min(max - total),
                None => PRUNE_CHUNK,
            };
            if chunk <= 0 {
                break;
            }
            let deleted = {
                let conn = self.writer();
                let mut stmt = conn.prepare_cached(delete_sql).map_err(db_err)?;
                let mut all: Vec<i64> = args.to_vec();
                all.push(chunk);
                stmt.execute(rusqlite::params_from_iter(all)).map_err(db_err)?
            };
            if deleted == 0 {
                break;
            }
            total += deleted as i64;
        }
        Ok(total)
    }

    /// Retención: borra por antigüedad y, si la base supera el tamaño máximo, las filas más
    /// antiguas hasta quedar por debajo del 90 % del límite.
    pub fn prune(&self) -> DbResult<()> {
        let retention = load_retention(&self.read_conn()?)?;

        let cutoff = now_micros() - retention.max_age_days.saturating_mul(MICROS_PER_DAY);
        let by_age = self.delete_in_chunks(
            "DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE ts < ?1 LIMIT ?2)",
            &[cutoff],
            None,
        )?;
        if by_age > 0 {
            self.reclaim()?;
        }

        let limit = retention.max_size_mb.saturating_mul(MB);
        let target = limit / 10 * 9;
        for _ in 0..SIZE_PRUNE_ROUNDS {
            let (size, used, rows) = {
                let conn = self.read_conn()?;
                let size = size_bytes(&conn)?;
                let used = size - free_bytes(&conn)?;
                let rows = conn
                    .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get::<_, i64>(0))
                    .map_err(db_err)?;
                (size, used, rows)
            };
            if size <= limit || rows == 0 {
                break;
            }
            // Estimación por tamaño medio de fila (incluye el índice FTS); se reevalúa por ronda.
            let per_row = (used as f64 / rows as f64).max(1.0);
            let excess = (used - target).max(0) as f64;
            let to_delete = ((excess / per_row).ceil() as i64).clamp(1, rows);
            let deleted = self.delete_in_chunks(
                "DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY ts, id LIMIT ?1)",
                &[],
                Some(to_delete),
            )?;
            // Las entradas borradas del índice FTS solo liberan espacio al fusionar segmentos.
            self.writer()
                .execute_batch("INSERT INTO logs_fts (logs_fts) VALUES ('optimize')")
                .map_err(db_err)?;
            self.reclaim()?;
            if deleted == 0 {
                break;
            }
        }

        self.writer().execute_batch("PRAGMA optimize").map_err(db_err)
    }
}
