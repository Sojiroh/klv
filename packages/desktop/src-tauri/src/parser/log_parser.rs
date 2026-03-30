use std::collections::HashMap;

use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

pub fn parse_log_level(raw: &str) -> LogLevel {
    match raw.to_lowercase().as_str() {
        "trace" => LogLevel::TRACE,
        "debug" => LogLevel::DEBUG,
        "info" | "information" => LogLevel::INFO,
        "warn" | "warning" => LogLevel::WARN,
        "error" | "err" => LogLevel::ERROR,
        "fatal" | "critical" | "panic" => LogLevel::FATAL,
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
    pub level: LogLevel,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
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
    pub extra: HashMap<String, serde_json::Value>,
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
    "service_name",
    "app",
    "application",
    "logger",
    "logger_name",
];
const TRACE_FIELDS: &[&str] = &[
    "trace_id",
    "traceId",
    "trace-id",
    "x-request-id",
    "request_id",
    "requestId",
    "correlationId",
];
const SPAN_FIELDS: &[&str] = &["span_id", "spanId", "span-id"];
const ERROR_FIELDS: &[&str] = &["error", "err", "exception", "error_message"];
const STACK_FIELDS: &[&str] = &["stack", "stackTrace", "stack_trace", "error.stack_trace"];
const CALLER_FIELDS: &[&str] = &["caller", "source", "class", "method", "function"];

fn all_known_fields() -> Vec<&'static str> {
    let mut fields = Vec::new();
    fields.extend_from_slice(LEVEL_FIELDS);
    fields.extend_from_slice(MESSAGE_FIELDS);
    fields.extend_from_slice(TIMESTAMP_FIELDS);
    fields.extend_from_slice(SERVICE_FIELDS);
    fields.extend_from_slice(TRACE_FIELDS);
    fields.extend_from_slice(SPAN_FIELDS);
    fields.extend_from_slice(ERROR_FIELDS);
    fields.extend_from_slice(STACK_FIELDS);
    fields.extend_from_slice(CALLER_FIELDS);
    fields
}

fn find_field(
    obj: &serde_json::Map<String, serde_json::Value>,
    candidates: &[&str],
) -> Option<String> {
    for &field in candidates {
        if field.contains('.') {
            let parts: Vec<&str> = field.split('.').collect();
            let mut current: Option<&serde_json::Value> = obj.get(parts[0]);
            for part in &parts[1..] {
                current = current
                    .and_then(|v| v.as_object())
                    .and_then(|o| o.get(*part));
            }
            if let Some(val) = current {
                return Some(value_to_string(val));
            }
        } else if let Some(val) = obj.get(field) {
            if !val.is_null() {
                return Some(value_to_string(val));
            }
        }
    }
    None
}

fn value_to_string(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn detect_level_from_message(message: &str) -> LogLevel {
    let upper = message.to_uppercase();
    if upper.contains("ERROR") || upper.contains("EXCEPTION") {
        return LogLevel::ERROR;
    }
    if upper.contains("WARN") {
        return LogLevel::WARN;
    }
    if upper.contains("DEBUG") {
        return LogLevel::DEBUG;
    }
    LogLevel::UNKNOWN
}

fn k8s_timestamp_regex() -> Regex {
    Regex::new(r"^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.+)$").unwrap()
}

pub fn parse_log_line(line: &str, pod_name: Option<&str>) -> ParsedLog {
    let trimmed = line.trim();
    let mut json_str = trimmed;
    let mut k8s_timestamp: Option<String> = None;

    let re = k8s_timestamp_regex();
    if let Some(caps) = re.captures(trimmed) {
        k8s_timestamp = Some(caps[1].to_string());
        json_str = caps.get(2).map(|m| m.as_str()).unwrap_or(trimmed);
    }

    if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(json_str)
    {
        let timestamp = find_field(&obj, TIMESTAMP_FIELDS).or_else(|| k8s_timestamp.clone());
        let level_raw = find_field(&obj, LEVEL_FIELDS);
        let message = find_field(&obj, MESSAGE_FIELDS).unwrap_or_default();
        let level = {
            let parsed = level_raw
                .as_deref()
                .map(parse_log_level)
                .unwrap_or(LogLevel::UNKNOWN);
            if parsed == LogLevel::UNKNOWN {
                detect_level_from_message(&message)
            } else {
                parsed
            }
        };

        let known = all_known_fields();
        let extra: HashMap<String, serde_json::Value> = obj
            .iter()
            .filter(|(k, v)| !known.contains(&k.as_str()) && !v.is_null())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        ParsedLog {
            raw: trimmed.to_string(),
            is_json: true,
            timestamp,
            level,
            message,
            service: find_field(&obj, SERVICE_FIELDS),
            trace_id: find_field(&obj, TRACE_FIELDS),
            span_id: find_field(&obj, SPAN_FIELDS),
            caller: find_field(&obj, CALLER_FIELDS),
            error: find_field(&obj, ERROR_FIELDS),
            stack_trace: find_field(&obj, STACK_FIELDS),
            pod_name: pod_name.map(String::from),
            extra,
        }
    } else {
        ParsedLog {
            raw: trimmed.to_string(),
            is_json: false,
            timestamp: k8s_timestamp,
            level: detect_level_from_message(trimmed),
            message: trimmed.to_string(),
            service: None,
            trace_id: None,
            span_id: None,
            caller: None,
            error: None,
            stack_trace: None,
            pod_name: pod_name.map(String::from),
            extra: HashMap::new(),
        }
    }
}
