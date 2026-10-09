//! Tipos JSON (camelCase) del historial local; contrato Q5.

use serde::{Deserialize, Serialize};

use crate::parser::log_parser::ParsedLog;
use crate::query::QueryNode;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorTarget {
    pub id: String,
    pub context: String,
    pub namespace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_selector: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorTargetInput {
    pub id: Option<String>,
    pub context: String,
    pub namespace: String,
    pub container: Option<String>,
    pub label_selector: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSettings {
    pub max_age_days: i64,
    pub max_size_mb: i64,
}

pub const DEFAULT_RETENTION: RetentionSettings = RetentionSettings {
    max_age_days: 7,
    max_size_mb: 1024,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryConfig {
    pub targets: Vec<CollectorTarget>,
    pub retention: RetentionSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryConfigInput {
    pub targets: Vec<CollectorTargetInput>,
    pub retention: RetentionSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamState {
    Following,
    Waiting,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorStream {
    pub pod: String,
    pub container: String,
    pub state: StreamState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_line_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetState {
    Running,
    Disabled,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorStatus {
    pub target_id: String,
    pub state: TargetState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub streams: Vec<CollectorStream>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStats {
    pub rows: i64,
    pub size_bytes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub newest: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub stats: HistoryStats,
    pub collectors: Vec<CollectorStatus>,
    pub data_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQueryRequest {
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub pods: Option<Vec<String>>,
    pub containers: Option<Vec<String>>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub query: Option<QueryNode>,
    pub limit: Option<i64>,
    pub before: Option<String>,
}

/// `ParsedLog` completo (con `podName` y `k8sTimestamp`) más el alcance de la fila.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLog {
    #[serde(flatten)]
    pub log: ParsedLog,
    pub context: String,
    pub namespace: String,
    pub container: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQueryResponse {
    pub logs: Vec<HistoryLog>,
    pub next_cursor: Option<String>,
    pub scanned: usize,
    pub truncated: bool,
}
