//! Tipos JSON (camelCase) del historial local; contrato Q5.

use serde::{Deserialize, Serialize};

use crate::parser::log_parser::{LogLevel, ParsedLog};
use crate::query::QueryNode;

/// Target del colector. Al leer `config.json` se acepta el `container` (string) de versiones
/// anteriores y se normaliza a `containers`; siempre se guarda `containers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "StoredCollectorTarget")]
pub struct CollectorTarget {
    pub id: String,
    pub context: String,
    pub namespace: String,
    /// Contenedores a seguir; ausente = todos.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub containers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_selector: Option<String>,
    pub enabled: bool,
    /// Descarta las líneas con nivel conocido por debajo de este (UNKNOWN siempre se conserva).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_level: Option<LogLevel>,
    /// Descarta las líneas cuyo mensaje contiene alguno de estos textos (distingue mayúsculas).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<String>>,
}

/// Forma de un target en `config.json`: admite `containers` y el `container` heredado.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCollectorTarget {
    id: String,
    context: String,
    namespace: String,
    container: Option<String>,
    containers: Option<Vec<String>>,
    label_selector: Option<String>,
    enabled: bool,
    min_level: Option<LogLevel>,
    exclude: Option<Vec<String>>,
}

impl From<StoredCollectorTarget> for CollectorTarget {
    fn from(stored: StoredCollectorTarget) -> Self {
        let containers = match stored.containers {
            Some(containers) => Some(containers),
            None => stored
                .container
                .filter(|c| !c.is_empty())
                .map(|c| vec![c]),
        }
        .filter(|containers| !containers.is_empty());
        Self {
            id: stored.id,
            context: stored.context,
            namespace: stored.namespace,
            containers,
            label_selector: stored.label_selector,
            enabled: stored.enabled,
            min_level: stored.min_level,
            exclude: stored.exclude,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorTargetInput {
    pub id: Option<String>,
    pub context: String,
    pub namespace: String,
    pub containers: Option<Vec<String>>,
    /// Forma heredada (un solo contenedor); solo se usa si `containers` está ausente.
    pub container: Option<String>,
    pub label_selector: Option<String>,
    pub enabled: bool,
    /// Texto crudo para poder responder con un mensaje de validación propio.
    pub min_level: Option<String>,
    pub exclude: Option<Vec<String>>,
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

fn default_retention() -> RetentionSettings {
    DEFAULT_RETENTION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryConfig {
    #[serde(default)]
    pub targets: Vec<CollectorTarget>,
    #[serde(default = "default_retention")]
    pub retention: RetentionSettings,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self {
            targets: Vec::new(),
            retention: DEFAULT_RETENTION,
        }
    }
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
