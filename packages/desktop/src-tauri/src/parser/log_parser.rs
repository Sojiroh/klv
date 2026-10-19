use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::{DateTime, Datelike, NaiveDateTime};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LogLevel {
    TRACE,
    DEBUG,
    INFO,
    WARN,
    ERROR,
    FATAL,
    UNKNOWN,
}

pub fn level_priority(level: &LogLevel) -> i32 {
    match level {
        LogLevel::UNKNOWN => -1,
        LogLevel::TRACE => 0,
        LogLevel::DEBUG => 1,
        LogLevel::INFO => 2,
        LogLevel::WARN => 3,
        LogLevel::ERROR => 4,
        LogLevel::FATAL => 5,
    }
}

// Alias de niveles (texto). Los niveles numéricos (pino/bunyan) se mapean aparte.
const LEVEL_ALIASES: &[(&str, LogLevel)] = &[
    ("trace", LogLevel::TRACE),
    ("debug", LogLevel::DEBUG),
    ("info", LogLevel::INFO),
    ("information", LogLevel::INFO),
    ("notice", LogLevel::INFO),
    ("warn", LogLevel::WARN),
    ("warning", LogLevel::WARN),
    ("error", LogLevel::ERROR),
    ("err", LogLevel::ERROR),
    ("fatal", LogLevel::FATAL),
    ("critical", LogLevel::FATAL),
    ("crit", LogLevel::FATAL),
    ("alert", LogLevel::FATAL),
    ("emergency", LogLevel::FATAL),
    ("emerg", LogLevel::FATAL),
    ("panic", LogLevel::FATAL),
];

fn level_from_number(n: f64) -> LogLevel {
    if !n.is_finite() {
        LogLevel::UNKNOWN
    } else if n >= 60.0 {
        LogLevel::FATAL
    } else if n >= 50.0 {
        LogLevel::ERROR
    } else if n >= 40.0 {
        LogLevel::WARN
    } else if n >= 30.0 {
        LogLevel::INFO
    } else if n >= 20.0 {
        LogLevel::DEBUG
    } else if n >= 10.0 {
        LogLevel::TRACE
    } else {
        LogLevel::UNKNOWN
    }
}

/// Nivel desde texto: numérico (`^\d+$`, pino/bunyan) o alias (sin distinguir mayúsculas).
pub fn parse_log_level(raw: &str) -> LogLevel {
    let text = raw.trim();
    if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
        return level_from_number(text.parse::<f64>().unwrap_or(f64::NAN));
    }
    LEVEL_ALIASES
        .iter()
        .find(|(name, _)| text.eq_ignore_ascii_case(name))
        .map_or(LogLevel::UNKNOWN, |&(_, level)| level)
}

fn level_from_value(value: Option<&Value>) -> LogLevel {
    match value {
        Some(Value::Number(n)) => n.as_f64().map_or(LogLevel::UNKNOWN, level_from_number),
        Some(Value::String(s)) => parse_log_level(s),
        _ => LogLevel::UNKNOWN,
    }
}

/// Nivel desde el atributo reservado `status` de Datadog: solo texto que sea un alias de nivel.
/// Los números (`200`, `"404"`) son códigos HTTP y se ignoran.
fn level_from_status(record: &Map<String, Value>) -> LogLevel {
    match record.get("status") {
        Some(Value::String(s)) => {
            let text = s.trim();
            LEVEL_ALIASES
                .iter()
                .find(|(name, _)| text.eq_ignore_ascii_case(name))
                .map_or(LogLevel::UNKNOWN, |&(_, level)| level)
        }
        _ => LogLevel::UNKNOWN,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedLog {
    pub raw: String,
    pub is_json: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub k8s_timestamp: Option<String>,
    pub level: LogLevel,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack_trace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pod_name: Option<String>,
    pub extra: Map<String, Value>,
}

const LEVEL_FIELDS: &[&str] = &[
    "level",
    "severity",
    "log.level",
    "loglevel",
    "lvl",
    "log_level",
];
const MESSAGE_FIELDS: &[&str] = &["message", "msg", "log", "text", "body"];
const TIMESTAMP_FIELDS: &[&str] = &[
    "timestamp",
    "time",
    "ts",
    "@timestamp",
    "datetime",
    "date",
    "logged_at",
];
const SERVICE_FIELDS: &[&str] = &[
    "service",
    "dd.service",
    "dd_service",
    "service_name",
    "app",
    "application",
    "logger",
    "logger_name",
];
const ENV_FIELDS: &[&str] = &["dd.env", "dd_env", "env"];
const VERSION_FIELDS: &[&str] = &["dd.version", "dd_version", "version"];
const TRACE_FIELDS: &[&str] = &[
    "dd.trace_id",
    "dd_trace_id",
    "trace_id",
    "traceId",
    "trace-id",
    "x-request-id",
    "request_id",
    "requestId",
    "correlationId",
];
const SPAN_FIELDS: &[&str] = &["dd.span_id", "dd_span_id", "span_id", "spanId", "span-id"];
const ERROR_FIELDS: &[&str] = &["error.message", "error", "err", "exception", "error_message"];
const STACK_FIELDS: &[&str] = &["error.stack", "stack", "stackTrace", "stack_trace", "error.stack_trace"];
const CALLER_FIELDS: &[&str] = &["caller", "source", "class", "method", "function"];

// Etiquetas del tracer de Datadog dentro de un objeto `dd` anidado (se hoistean a campos propios)
const DD_TAGS: &[&str] = &["trace_id", "span_id", "service", "env", "version"];

// Campos "conocidos" que se extraen y no van en extra
static KNOWN_FIELDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        LEVEL_FIELDS,
        MESSAGE_FIELDS,
        TIMESTAMP_FIELDS,
        SERVICE_FIELDS,
        ENV_FIELDS,
        VERSION_FIELDS,
        TRACE_FIELDS,
        SPAN_FIELDS,
        ERROR_FIELDS,
        STACK_FIELDS,
        CALLER_FIELDS,
    ]
    .into_iter()
    .flatten()
    .copied()
    .collect()
});

// `(?-u)`: \b, \d y [A-Za-z] ASCII, igual que las regex de JS
static K8S_TIMESTAMP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?)\s+(.+)$")
        .expect("regex de timestamp de kubelet válida")
});
static LOGFMT_LEVEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i-u)\b(?:level|lvl|severity)=["']?([A-Za-z]+|\d+)"#)
        .expect("regex de nivel logfmt válida")
});
static LEVEL_KEYWORD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)\b(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|ALERT|EMERG|EMERGENCY|PANIC)\b",
    )
    .expect("regex de palabras clave de nivel válida")
});
static ERROR_WORD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b(?:error|exception)\b").expect("regex de error válida")
});
static ERROR_SUFFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)[a-z](?:Exception|Error)\b").expect("regex de sufijo de error válida")
});
static WARN_WORD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\bwarn(?:ing)?\b").expect("regex de warn válida"));

// Primero la clave plana literal ("log.level"), luego el recorrido anidado. Los null se ignoran.
fn find_value<'a>(obj: &'a Map<String, Value>, candidates: &[&str]) -> Option<&'a Value> {
    for &field in candidates {
        if let Some(value) = obj.get(field).filter(|v| !v.is_null()) {
            return Some(value);
        }
        if !field.contains('.') {
            continue;
        }

        let mut parts = field.split('.');
        let mut current = parts.next().and_then(|first| obj.get(first));
        for part in parts {
            current = current
                .and_then(Value::as_object)
                .and_then(|nested| nested.get(part));
        }
        if let Some(value) = current.filter(|v| !v.is_null()) {
            return Some(value);
        }
    }
    None
}

fn stringify(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            // JS imprime los floats enteros sin parte decimal
            Some(f) if n.is_f64() && f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 => {
                format!("{f:.0}")
            }
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

fn find_field(obj: &Map<String, Value>, candidates: &[&str]) -> Option<String> {
    find_value(obj, candidates).map(stringify)
}

fn detect_level_from_text(text: &str) -> LogLevel {
    if let Some(caps) = LOGFMT_LEVEL_RE.captures(text) {
        let level = parse_log_level(&caps[1]);
        if level != LogLevel::UNKNOWN {
            return level;
        }
    }

    if let Some(keyword) = LEVEL_KEYWORD_RE.find(text) {
        return parse_log_level(keyword.as_str());
    }

    if ERROR_WORD_RE.is_match(text) || ERROR_SUFFIX_RE.is_match(text) {
        return LogLevel::ERROR;
    }
    if WARN_WORD_RE.is_match(text) {
        return LogLevel::WARN;
    }
    LogLevel::UNKNOWN
}

// `^\d+(\.\d+)?$`
fn is_decimal_number(text: &str) -> bool {
    let (int_part, frac_part) = match text.split_once('.') {
        Some((int_part, frac_part)) => (int_part, Some(frac_part)),
        None => (text, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(int_part) && frac_part.is_none_or(digits)
}

// Límite de fechas de JS (TimeClip)
const MAX_DATE_MS: f64 = 8.64e15;

// Epochs numéricos (s, ms, µs, ns) a ISO-8601 UTC como `Date.prototype.toISOString`;
// cualquier otro valor se conserva tal cual.
fn normalize_timestamp(value: &Value) -> String {
    let original = stringify(value);
    let n = match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if is_decimal_number(s) => s.parse::<f64>().ok(),
        _ => None,
    };
    let Some(n) = n else {
        return original;
    };

    let scaled = if n < 1e11 {
        n * 1e3
    } else if n < 1e14 {
        n
    } else if n < 1e17 {
        n / 1e3
    } else {
        n / 1e6
    };
    let ms = scaled.trunc();
    if !ms.is_finite() || ms.abs() > MAX_DATE_MS {
        return original;
    }

    // |ms| <= 8.64e15 cabe en i64
    match DateTime::from_timestamp_millis(ms as i64) {
        Some(date) => {
            let year = date.year();
            if (0..=9999).contains(&year) {
                date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
            } else {
                let sign = if year < 0 { '-' } else { '+' };
                format!(
                    "{sign}{:06}{}",
                    year.unsigned_abs(),
                    date.format("-%m-%dT%H:%M:%S%.3fZ")
                )
            }
        }
        None => original,
    }
}

pub fn parse_log_line(line: &str, pod_name: Option<&str>) -> ParsedLog {
    let trimmed = line.trim();
    let mut json_str = trimmed;
    let mut k8s_timestamp: Option<String> = None;

    // Formato: "2024-01-15T10:30:00.000Z {json...}"
    if let Some(caps) = K8S_TIMESTAMP_RE.captures(trimmed) {
        k8s_timestamp = Some(caps[1].to_string());
        json_str = caps.get(2).map_or(trimmed, |m| m.as_str());
    }

    let record = if json_str.starts_with('{') {
        serde_json::from_str::<Map<String, Value>>(json_str).ok()
    } else {
        None
    };

    let Some(record) = record else {
        return ParsedLog {
            raw: trimmed.to_string(),
            is_json: false,
            timestamp: k8s_timestamp.clone(),
            k8s_timestamp,
            level: detect_level_from_text(trimmed),
            message: trimmed.to_string(),
            service: None,
            env: None,
            version: None,
            trace_id: None,
            span_id: None,
            caller: None,
            error: None,
            stack_trace: None,
            pod_name: pod_name.map(String::from),
            extra: Map::new(),
        };
    };

    let timestamp = find_value(&record, TIMESTAMP_FIELDS)
        .map(normalize_timestamp)
        .or_else(|| k8s_timestamp.clone());
    let message = find_field(&record, MESSAGE_FIELDS).unwrap_or_default();
    let mut level = level_from_value(find_value(&record, LEVEL_FIELDS));
    let mut status_is_level = false;
    if level == LogLevel::UNKNOWN {
        let status_level = level_from_status(&record);
        if status_level != LogLevel::UNKNOWN {
            level = status_level;
            status_is_level = true;
        }
    }
    if level == LogLevel::UNKNOWN {
        level = detect_level_from_text(&message);
    }

    let service = find_field(&record, SERVICE_FIELDS);
    let env = find_field(&record, ENV_FIELDS);
    let version = find_field(&record, VERSION_FIELDS);
    let trace_id = find_field(&record, TRACE_FIELDS);
    let span_id = find_field(&record, SPAN_FIELDS);
    let caller = find_field(&record, CALLER_FIELDS);
    // Un `error` objeto (estándar Datadog) nunca se convierte a texto: se hoistean message/stack y el resto queda en extra
    let error_is_object = matches!(record.get("error"), Some(Value::Object(_)));
    let error = if error_is_object {
        let candidates: Vec<&str> = ERROR_FIELDS.iter().copied().filter(|f| *f != "error").collect();
        find_field(&record, &candidates)
    } else {
        find_field(&record, ERROR_FIELDS)
    };
    let stack_trace = find_field(&record, STACK_FIELDS);

    // Todo lo que no es un campo conocido, en el orden del JSON original.
    // `status` solo se excluye cuando aportó el nivel.
    let mut extra: Map<String, Value> = Map::new();
    for (key, value) in record {
        if status_is_level && key == "status" {
            continue;
        }
        if key == "error" {
            if let Value::Object(mut obj) = value {
                obj.retain(|k, _| !matches!(k.as_str(), "message" | "stack" | "stack_trace"));
                if !obj.is_empty() {
                    extra.insert(key, Value::Object(obj));
                }
            }
            continue;
        }
        if !KNOWN_FIELDS.contains(key.as_str()) && !value.is_null() {
            extra.insert(key, value);
        }
    }

    // Las etiquetas del tracer ya son campos de primer nivel: se quitan de `dd` para no duplicar facetas
    if let Some(Value::Object(dd)) = extra.get_mut("dd") {
        dd.retain(|key, _| !DD_TAGS.contains(&key.as_str()));
        if dd.is_empty() {
            extra.remove("dd");
        }
    }

    ParsedLog {
        raw: trimmed.to_string(),
        is_json: true,
        timestamp,
        k8s_timestamp,
        level,
        message,
        service,
        env,
        version,
        trace_id,
        span_id,
        caller,
        error,
        stack_trace,
        pod_name: pod_name.map(String::from),
        extra,
    }
}

// Equivalente a `Date.parse` para los formatos que emiten kubelet y las apps (sin offset = UTC).
fn parse_time_ms(text: &str) -> Option<i64> {
    if let Ok(date) = DateTime::parse_from_rfc3339(text) {
        return Some(date.timestamp_millis());
    }
    ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"]
        .iter()
        .find_map(|format| NaiveDateTime::parse_from_str(text, format).ok())
        .map(|date| date.and_utc().timestamp_millis())
}

/// Orden cronológico (estable) de logs agregados: clave = `k8s_timestamp ?? timestamp`;
/// las claves no parseables van al final y los empates se resuelven comparando las claves como texto.
pub fn sort_logs_by_time(logs: &mut [ParsedLog]) {
    logs.sort_by_cached_key(|log| {
        let key = log
            .k8s_timestamp
            .as_deref()
            .or(log.timestamp.as_deref())
            .unwrap_or("");
        match parse_time_ms(key) {
            Some(ms) => (false, ms, key.to_string()),
            None => (true, 0, key.to_string()),
        }
    });
}
