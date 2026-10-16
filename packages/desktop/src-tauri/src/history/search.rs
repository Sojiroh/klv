//! Consulta del historial: paginación por clave (ts, id) de lo más nuevo a lo más antiguo sobre
//! `current ∪ segmentos Parquet`, prefiltro SQL superconjunto opcional y filtro exacto con
//! `matches_query`.

use std::path::Path;

use chrono::DateTime;
use duckdb::types::Value;
use duckdb::{params_from_iter, Connection};

use super::db::{db_err, level_str, sql_quote, DbResult, COLUMNS};
use super::types::{HistoryLog, HistoryQueryRequest, HistoryQueryResponse};
use crate::error::KlvError;
use crate::names::{validate_name, NameKind};
use crate::parser::log_parser::{level_priority, parse_log_level, parse_log_line, LogLevel};
use crate::query::{
    matches_query, CompareValue, FieldTest, QueryField, QueryNode, QueryTarget, ReservedField,
};

const DEFAULT_LIMIT: usize = 1000;
const MAX_LIMIT: usize = 10_000;
/// Filas candidatas máximas evaluadas por petición.
const SCAN_BUDGET: usize = 200_000;
/// Filas máximas por consulta SQL.
const MAX_PAGE: usize = 5000;
/// Bytes de Parquet máximos que se leen en una misma consulta (un bucket nunca se divide).
const CHUNK_BYTES: i64 = 256 * 1024 * 1024;

const SEARCHABLE_LEVELS: [LogLevel; 6] = [
    LogLevel::TRACE,
    LogLevel::DEBUG,
    LogLevel::INFO,
    LogLevel::WARN,
    LogLevel::ERROR,
    LogLevel::FATAL,
];

/// Petición validada y normalizada.
pub struct QueryPlan {
    context: Option<String>,
    namespace: Option<String>,
    pods: Vec<String>,
    containers: Vec<String>,
    from_us: Option<i64>,
    to_us: Option<i64>,
    query: Option<QueryNode>,
    limit: usize,
    before: Option<(i64, i64)>,
}

fn parse_time(label: &str, text: &str) -> Result<i64, KlvError> {
    DateTime::parse_from_rfc3339(text)
        .map(|d| d.timestamp_micros())
        .map_err(|_| KlvError::new(format!("Fecha \"{label}\" inválida: \"{text}\"")))
}

fn parse_cursor(text: &str) -> Result<(i64, i64), KlvError> {
    text.split_once(':')
        .and_then(|(ts, id)| Some((ts.parse().ok()?, id.parse().ok()?)))
        .ok_or_else(|| KlvError::new("Cursor inválido"))
}

fn format_cursor((ts, id): (i64, i64)) -> String {
    format!("{ts}:{id}")
}

fn validated_names(
    kind: NameKind,
    names: Option<Vec<String>>,
) -> Result<Vec<String>, KlvError> {
    let names = names.unwrap_or_default();
    for name in &names {
        validate_name(kind, name)?;
    }
    Ok(names)
}

impl QueryPlan {
    pub fn new(request: HistoryQueryRequest) -> Result<Self, KlvError> {
        if let Some(namespace) = &request.namespace {
            validate_name(NameKind::Namespace, namespace)?;
        }
        let pods = validated_names(NameKind::Pod, request.pods)?;
        let containers = validated_names(NameKind::Container, request.containers)?;

        let limit = match request.limit {
            None => DEFAULT_LIMIT,
            Some(limit) => usize::try_from(limit)
                .ok()
                .filter(|l| (1..=MAX_LIMIT).contains(l))
                .ok_or_else(|| {
                    KlvError::new(format!("limit inválido: debe estar entre 1 y {MAX_LIMIT}"))
                })?,
        };

        Ok(Self {
            context: request.context,
            namespace: request.namespace,
            pods,
            containers,
            from_us: request.from.as_deref().map(|t| parse_time("from", t)).transpose()?,
            to_us: request.to.as_deref().map(|t| parse_time("to", t)).transpose()?,
            query: request.query,
            limit,
            before: request.before.as_deref().map(parse_cursor).transpose()?,
        })
    }
}

// --- Prefiltro SQL (siempre un superconjunto de lo que acepta `matches_query`) ---

type Fragment = (String, Vec<Value>);

fn text_arg(value: String) -> Value {
    Value::Text(value)
}

/// Solo ASCII imprimible: el `lower`/`ILIKE` de DuckDB y el `to_lowercase` de Rust coinciden.
fn printable_ascii(text: &str) -> bool {
    text.chars().all(|c| matches!(c, ' '..='~'))
}

/// `%texto%` con `\`, `%` y `_` escapados (para `ILIKE ... ESCAPE '\'`).
fn like_pattern(text: &str) -> String {
    let mut pattern = String::with_capacity(text.len() + 2);
    pattern.push('%');
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

/// Texto libre: aparece en message, error o stack_trace (el corpus que evalúa `matches_query`).
/// Con comodín basta exigir el tramo literal más largo.
fn text_fragment(value: &str, wildcard: bool) -> Option<Fragment> {
    let literal = if wildcard {
        value
            .split('*')
            .filter(|piece| !piece.is_empty() && printable_ascii(piece))
            .max_by_key(|piece| piece.len())?
    } else if !value.is_empty() && printable_ascii(value) {
        value
    } else {
        return None;
    };
    let pattern = like_pattern(literal);
    Some((
        "message ILIKE ? ESCAPE '\\' OR error ILIKE ? ESCAPE '\\' OR stack_trace ILIKE ? ESCAPE '\\'"
            .to_string(),
        vec![
            text_arg(pattern.clone()),
            text_arg(pattern.clone()),
            text_arg(pattern),
        ],
    ))
}

fn reserved_column(name: ReservedField) -> &'static str {
    match name {
        ReservedField::Level => "level",
        ReservedField::Service => "service",
        ReservedField::Env => "env",
        ReservedField::Version => "version",
        ReservedField::Pod => "pod",
        ReservedField::Container => "container",
        ReservedField::Namespace => "namespace",
        ReservedField::Trace => "trace_id",
        ReservedField::Span => "span_id",
        ReservedField::Caller => "caller",
        ReservedField::Message => "message",
        ReservedField::Error => "error",
    }
}

fn level_fragment(test: &FieldTest) -> Option<Fragment> {
    let compare = |value: &CompareValue, keep: fn(i32, i32) -> bool| -> Option<Fragment> {
        let CompareValue::Text(name) = value else {
            return None;
        };
        if !name.bytes().all(|b| b.is_ascii_alphabetic()) {
            return None;
        }
        let bound = parse_log_level(name);
        if bound == LogLevel::UNKNOWN {
            return None;
        }
        let names: Vec<&str> = SEARCHABLE_LEVELS
            .iter()
            .filter(|l| keep(level_priority(l), level_priority(&bound)))
            .map(|l| level_str(*l))
            .collect();
        let list = names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ");
        Some((
            if names.is_empty() { "false".to_string() } else { format!("level IN ({list})") },
            Vec::new(),
        ))
    };
    match test {
        FieldTest::Eq { value, .. } => Some(("level = ?".to_string(), vec![text_arg(value.clone())])),
        FieldTest::Gt { value } => compare(value, |c, v| c > v),
        FieldTest::Gte { value } => compare(value, |c, v| c >= v),
        FieldTest::Lt { value } => compare(value, |c, v| c < v),
        FieldTest::Lte { value } => compare(value, |c, v| c <= v),
        FieldTest::Exists | FieldTest::Range { .. } => None,
    }
}

fn combine(parts: Vec<Fragment>, joiner: &str) -> Option<Fragment> {
    if parts.is_empty() {
        return None;
    }
    let mut sql = Vec::with_capacity(parts.len());
    let mut args = Vec::new();
    for (part_sql, part_args) in parts {
        sql.push(format!("({part_sql})"));
        args.extend(part_args);
    }
    Some((sql.join(joiner), args))
}

fn prefilter(node: &QueryNode) -> Option<Fragment> {
    match node {
        // Un AND restringe con cualquiera de sus hijos; un OR solo si todos restringen.
        QueryNode::And { children } => combine(children.iter().filter_map(prefilter).collect(), " AND "),
        QueryNode::Or { children } => {
            let parts: Option<Vec<Fragment>> = children.iter().map(prefilter).collect();
            combine(parts?, " OR ")
        }
        QueryNode::Not { .. } => None,
        QueryNode::Text { value, wildcard } => text_fragment(value, *wildcard),
        QueryNode::Field { field, test } => match field {
            QueryField::Reserved {
                name: ReservedField::Level,
            } => level_fragment(test),
            QueryField::Reserved { name } => {
                let column = reserved_column(*name);
                match test {
                    FieldTest::Eq {
                        value,
                        wildcard: false,
                    } if printable_ascii(value) => Some((
                        format!("lower({column}) = lower(?)"),
                        vec![text_arg(value.clone())],
                    )),
                    FieldTest::Exists => {
                        Some((format!("{column} IS NOT NULL AND {column} <> ''"), Vec::new()))
                    }
                    _ => None,
                }
            }
            // Los atributos viven en `raw`: solo el evaluador en memoria los comprueba.
            QueryField::Attr { .. } => None,
        },
    }
}

// --- Fuentes de datos ---

struct Segment {
    bucket_us: i64,
    file: String,
    bytes: i64,
}

/// Buckets consecutivos (de más nuevo a más antiguo) que se consultan juntos. Los rangos de
/// tiempo de los chunks son contiguos: `[start, end)`, sin cota en los extremos.
struct Chunk {
    start: Option<i64>,
    end: Option<i64>,
    segments: Vec<Segment>,
}

fn load_chunks(conn: &Connection, plan: &QueryPlan) -> DbResult<Vec<Chunk>> {
    let mut sql = String::from("SELECT bucket_us, file, bytes FROM segments WHERE 1 = 1");
    if let Some(from) = plan.from_us {
        sql.push_str(&format!(" AND max_ts_us >= {from}"));
    }
    if let Some(to) = plan.to_us {
        sql.push_str(&format!(" AND min_ts_us < {to}"));
    }
    // Segmentos enteramente más nuevos que el cursor no aportan filas.
    if let Some((ts, _)) = plan.before {
        sql.push_str(&format!(" AND min_ts_us <= {ts}"));
    }
    sql.push_str(" ORDER BY bucket_us DESC, id DESC");

    let segments = {
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let segments = stmt
            .query_map([], |r| {
                Ok(Segment {
                    bucket_us: r.get(0)?,
                    file: r.get(1)?,
                    bytes: r.get(2)?,
                })
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        segments
    };

    let mut groups: Vec<Vec<Segment>> = Vec::new();
    let mut bytes = 0i64;
    for segment in segments {
        let fits = groups.last().is_some_and(|group| {
            group.last().is_some_and(|last| last.bucket_us == segment.bucket_us)
                || bytes + segment.bytes <= CHUNK_BYTES
        });
        if !fits {
            groups.push(Vec::new());
            bytes = 0;
        }
        bytes += segment.bytes;
        if let Some(group) = groups.last_mut() {
            group.push(segment);
        }
    }
    if groups.is_empty() {
        groups.push(Vec::new());
    }

    let starts: Vec<Option<i64>> = groups
        .iter()
        .map(|group| group.last().map(|s| s.bucket_us))
        .collect();
    let oldest = groups.len() - 1;
    Ok(groups
        .into_iter()
        .enumerate()
        .map(|(index, segments)| Chunk {
            start: if index == oldest { None } else { starts[index] },
            end: if index == 0 { None } else { starts[index - 1] },
            segments,
        })
        .collect())
}

// --- Ejecución ---

/// SQL (sin cursor ni límite) y argumentos de un chunk.
struct ChunkQuery {
    sql: String,
    args: Vec<Value>,
}

fn build_chunk_query(plan: &QueryPlan, chunk: &Chunk, segments_dir: &Path) -> ChunkQuery {
    let mut source = format!("SELECT {COLUMNS} FROM current WHERE 1 = 1");
    if let Some(start) = chunk.start {
        source.push_str(&format!(" AND ts_us >= {start}"));
    }
    if let Some(end) = chunk.end {
        source.push_str(&format!(" AND ts_us < {end}"));
    }
    // Un archivo borrado por la retención mientras se consulta se omite.
    let files: Vec<String> = chunk
        .segments
        .iter()
        .map(|s| segments_dir.join(&s.file))
        .filter(|path| path.exists())
        .map(|path| sql_quote(&path.to_string_lossy()))
        .collect();
    if !files.is_empty() {
        source.push_str(&format!(
            " UNION ALL SELECT {COLUMNS} FROM read_parquet([{}])",
            files.join(", ")
        ));
    }

    let mut sql = format!(
        "SELECT l.id, l.ts_us, l.context, l.namespace, l.pod, l.container, l.k8s_timestamp, l.raw \
         FROM ({source}) l WHERE 1 = 1"
    );
    let mut args: Vec<Value> = Vec::new();

    if let Some(context) = &plan.context {
        sql.push_str(" AND l.context = ?");
        args.push(text_arg(context.clone()));
    }
    if let Some(namespace) = &plan.namespace {
        sql.push_str(" AND l.namespace = ?");
        args.push(text_arg(namespace.clone()));
    }
    for (column, values) in [("pod", &plan.pods), ("container", &plan.containers)] {
        if !values.is_empty() {
            let marks = vec!["?"; values.len()].join(", ");
            sql.push_str(&format!(" AND l.{column} IN ({marks})"));
            args.extend(values.iter().cloned().map(text_arg));
        }
    }
    if let Some(from) = plan.from_us {
        sql.push_str(" AND l.ts_us >= ?");
        args.push(Value::BigInt(from));
    }
    if let Some(to) = plan.to_us {
        sql.push_str(" AND l.ts_us < ?");
        args.push(Value::BigInt(to));
    }
    if let Some((pre_sql, pre_args)) = plan.query.as_ref().and_then(prefilter) {
        sql.push_str(&format!(" AND ({pre_sql})"));
        args.extend(pre_args);
    }
    ChunkQuery { sql, args }
}

/// Fila mínima para reconstruir el `HistoryLog`: el resto sale de reparsear `raw`.
struct PageRow {
    id: i64,
    ts_us: i64,
    context: String,
    namespace: String,
    pod: String,
    container: String,
    k8s_timestamp: String,
    raw: String,
}

fn fetch_page(
    conn: &Connection,
    query: &ChunkQuery,
    position: (i64, i64),
    size: usize,
) -> DbResult<Vec<PageRow>> {
    let sql = format!(
        "{} AND (l.ts_us < ? OR (l.ts_us = ? AND l.id < ?)) ORDER BY l.ts_us DESC, l.id DESC LIMIT {size}",
        query.sql
    );
    let mut args = query.args.clone();
    args.extend([
        Value::BigInt(position.0),
        Value::BigInt(position.0),
        Value::BigInt(position.1),
    ]);
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(params_from_iter(args), |r| {
            Ok(PageRow {
                id: r.get(0)?,
                ts_us: r.get(1)?,
                context: r.get(2)?,
                namespace: r.get(3)?,
                pod: r.get(4)?,
                container: r.get(5)?,
                k8s_timestamp: r.get(6)?,
                raw: r.get(7)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

fn to_history_log(row: PageRow) -> HistoryLog {
    let mut log = parse_log_line(&row.raw, Some(&row.pod));
    log.k8s_timestamp = Some(row.k8s_timestamp);
    HistoryLog {
        log,
        context: row.context,
        namespace: row.namespace,
        container: row.container,
    }
}

fn scan(
    conn: &Connection,
    segments_dir: &Path,
    plan: &QueryPlan,
) -> DbResult<HistoryQueryResponse> {
    let chunks = load_chunks(conn, plan)?;
    let mut chunk_index = 0;
    let mut query = build_chunk_query(plan, &chunks[chunk_index], segments_dir);

    let mut position = plan.before.unwrap_or((i64::MAX, i64::MAX));
    let mut page_size = plan.limit.clamp(100, MAX_PAGE);
    let mut logs: Vec<HistoryLog> = Vec::new();
    let mut scanned = 0usize;
    let mut next_cursor = None;
    let mut truncated = false;

    'scan: loop {
        let size = page_size.min(SCAN_BUDGET - scanned);
        let rows = fetch_page(conn, &query, position, size)?;
        let count = rows.len();

        for (i, row) in rows.into_iter().enumerate() {
            scanned += 1;
            position = (row.ts_us, row.id);
            let entry = to_history_log(row);
            let target = QueryTarget {
                log: &entry.log,
                namespace: Some(&entry.namespace),
                container: Some(&entry.container),
            };
            if !matches_query(&target, plan.query.as_ref()) {
                continue;
            }
            logs.push(entry);
            if logs.len() == plan.limit {
                // Quedan filas por revisar salvo que este sea el final de los datos.
                if i + 1 < count || count == size || chunk_index + 1 < chunks.len() {
                    next_cursor = Some(format_cursor(position));
                }
                break 'scan;
            }
        }

        if count < size {
            // Chunk agotado: lo que sigue es más antiguo que todo lo ya examinado.
            chunk_index += 1;
            if chunk_index >= chunks.len() {
                break;
            }
            query = build_chunk_query(plan, &chunks[chunk_index], segments_dir);
        }
        if scanned >= SCAN_BUDGET {
            truncated = true;
            next_cursor = Some(format_cursor(position));
            break;
        }
        page_size = (page_size * 2).min(MAX_PAGE);
    }

    logs.reverse();
    Ok(HistoryQueryResponse {
        logs,
        next_cursor,
        scanned,
        truncated,
    })
}

/// Devuelve las `limit` coincidencias más nuevas en orden ascendente. Toda la consulta corre en
/// una transacción para ver un estado coherente de `segments` y `current` aunque haya un
/// rollover en curso.
pub fn run_query(
    conn: &Connection,
    segments_dir: &Path,
    plan: &QueryPlan,
) -> DbResult<HistoryQueryResponse> {
    conn.execute_batch("BEGIN TRANSACTION").map_err(db_err)?;
    let result = scan(conn, segments_dir, plan);
    // Solo lectura: no hay nada que confirmar.
    let _ = conn.execute_batch("ROLLBACK");
    result
}
