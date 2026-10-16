//! Consulta del historial: alcance/tiempo/cursor en SQL, prefiltro superconjunto opcional
//! (FTS trigram y nivel) y filtro exacto con `matches_query`.

use chrono::DateTime;
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};

use super::db::{db_err, DbResult};
use super::types::{HistoryLog, HistoryQueryRequest, HistoryQueryResponse};
use crate::error::KlvError;
use crate::names::{validate_name, NameKind};
use crate::parser::log_parser::{level_priority, parse_log_level, LogLevel, ParsedLog};
use crate::query::{
    matches_query, CompareValue, FieldTest, QueryField, QueryNode, QueryTarget, ReservedField,
};
use serde_json::Map;

const DEFAULT_LIMIT: usize = 1000;
const MAX_LIMIT: usize = 10_000;
/// Filas candidatas máximas evaluadas por petición.
const SCAN_BUDGET: usize = 200_000;

const SELECT_COLUMNS: &str = "id, context, namespace, pod, container, ts, k8s_timestamp, timestamp, \
    level, message, service, env, version, trace_id, span_id, caller, error, stack_trace, is_json, raw, extra";

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

fn format_cursor(ts: i64, id: i64) -> String {
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

/// Frase FTS5 (subcadena con el tokenizador trigram) o `None` si no se puede garantizar el
/// superconjunto: menos de 3 caracteres, no ASCII imprimible, o comillas/barras que el JSON
/// de `extra` escaparía.
fn fts_phrase(text: &str) -> Option<String> {
    let usable = text.chars().count() >= 3
        && text
            .chars()
            .all(|c| matches!(c, ' '..='~') && c != '"' && c != '\\');
    usable.then(|| format!("\"{text}\""))
}

/// Cada segmento entre comodines debe aparecer en el texto de búsqueda.
fn fts_fragment(value: &str, wildcard: bool) -> Option<Fragment> {
    let phrases: Vec<String> = if wildcard {
        value.split('*').filter_map(fts_phrase).collect()
    } else {
        fts_phrase(value).into_iter().collect()
    };
    if phrases.is_empty() {
        return None;
    }
    Some((
        "id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)".to_string(),
        vec![Value::Text(phrases.join(" AND "))],
    ))
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
            .map(|l| super::db::level_str(*l))
            .collect();
        let list = names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ");
        Some((
            if names.is_empty() { "0".to_string() } else { format!("level IN ({list})") },
            Vec::new(),
        ))
    };
    match test {
        FieldTest::Eq { value, .. } => Some(("level = ?".to_string(), vec![Value::Text(value.clone())])),
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
        QueryNode::Text { value, wildcard } => fts_fragment(value, *wildcard),
        QueryNode::Field { field, test } => match field {
            QueryField::Reserved {
                name: ReservedField::Level,
            } => level_fragment(test),
            QueryField::Reserved { .. } => match test {
                FieldTest::Eq { value, wildcard } => fts_fragment(value, *wildcard),
                _ => None,
            },
            QueryField::Attr { .. } => match test {
                FieldTest::Eq {
                    value,
                    wildcard: false,
                } => fts_fragment(value, false),
                _ => None,
            },
        },
    }
}

// --- Ejecución ---

fn json_array(values: &[String]) -> Value {
    Value::Text(serde_json::Value::from(values).to_string())
}

fn build_sql(plan: &QueryPlan) -> (String, Vec<Value>) {
    let mut sql = format!("SELECT {SELECT_COLUMNS} FROM logs WHERE 1 = 1");
    let mut args: Vec<Value> = Vec::new();

    if let Some(context) = &plan.context {
        sql.push_str(" AND context = ?");
        args.push(Value::Text(context.clone()));
    }
    if let Some(namespace) = &plan.namespace {
        sql.push_str(" AND namespace = ?");
        args.push(Value::Text(namespace.clone()));
    }
    if !plan.pods.is_empty() {
        sql.push_str(" AND pod IN (SELECT value FROM json_each(?))");
        args.push(json_array(&plan.pods));
    }
    if !plan.containers.is_empty() {
        sql.push_str(" AND container IN (SELECT value FROM json_each(?))");
        args.push(json_array(&plan.containers));
    }
    if let Some(from) = plan.from_us {
        sql.push_str(" AND ts >= ?");
        args.push(Value::Integer(from));
    }
    if let Some(to) = plan.to_us {
        sql.push_str(" AND ts < ?");
        args.push(Value::Integer(to));
    }
    if let Some((ts, id)) = plan.before {
        sql.push_str(" AND (ts < ? OR (ts = ? AND id < ?))");
        args.extend([Value::Integer(ts), Value::Integer(ts), Value::Integer(id)]);
    }
    if let Some((pre_sql, pre_args)) = plan.query.as_ref().and_then(prefilter) {
        sql.push_str(&format!(" AND ({pre_sql})"));
        args.extend(pre_args);
    }
    sql.push_str(" ORDER BY ts DESC, id DESC");
    (sql, args)
}

fn read_log(row: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, i64, HistoryLog)> {
    let level: String = row.get(8)?;
    let pod: String = row.get(3)?;
    let extra: String = row.get(20)?;
    let k8s_timestamp: String = row.get(6)?;
    let log = ParsedLog {
        raw: row.get(19)?,
        is_json: row.get(18)?,
        timestamp: row.get(7)?,
        k8s_timestamp: Some(k8s_timestamp),
        level: parse_log_level(&level),
        message: row.get(9)?,
        service: row.get(10)?,
        env: row.get(11)?,
        version: row.get(12)?,
        trace_id: row.get(13)?,
        span_id: row.get(14)?,
        caller: row.get(15)?,
        error: row.get(16)?,
        stack_trace: row.get(17)?,
        pod_name: Some(pod),
        extra: serde_json::from_str(&extra).unwrap_or_else(|_| Map::new()),
    };
    Ok((
        row.get(0)?,
        row.get(5)?,
        HistoryLog {
            log,
            context: row.get(1)?,
            namespace: row.get(2)?,
            container: row.get(4)?,
        },
    ))
}

/// Devuelve las `limit` coincidencias más nuevas en orden ascendente.
pub fn run_query(conn: &Connection, plan: &QueryPlan) -> DbResult<HistoryQueryResponse> {
    let (sql, args) = build_sql(plan);
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mut rows = stmt.query(params_from_iter(args)).map_err(db_err)?;

    let mut logs: Vec<HistoryLog> = Vec::new();
    let mut scanned = 0usize;
    let mut last: Option<(i64, i64)> = None;
    let mut next_cursor = None;
    let mut truncated = false;

    loop {
        if logs.len() >= plan.limit || scanned >= SCAN_BUDGET {
            // Quedan filas sin examinar -> cursor para continuar; presupuesto agotado sin
            // completar el límite -> truncado.
            if rows.next().map_err(db_err)?.is_some() {
                next_cursor = last.map(|(ts, id)| format_cursor(ts, id));
                truncated = logs.len() < plan.limit;
            }
            break;
        }
        let Some(row) = rows.next().map_err(db_err)? else {
            break;
        };
        scanned += 1;
        let (id, ts, entry) = read_log(row).map_err(db_err)?;
        last = Some((ts, id));
        let target = QueryTarget {
            log: &entry.log,
            namespace: Some(&entry.namespace),
            container: Some(&entry.container),
        };
        if matches_query(&target, plan.query.as_ref()) {
            logs.push(entry);
        }
    }

    logs.reverse();
    Ok(HistoryQueryResponse {
        logs,
        next_cursor,
        scanned,
        truncated,
    })
}
