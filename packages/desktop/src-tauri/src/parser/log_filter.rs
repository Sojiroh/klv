use crate::parser::log_parser::{level_priority, LogLevel, ParsedLog};

#[derive(Debug, Clone)]
pub struct LogFilter {
    pub level: Option<LogLevel>,
    pub min_level: Option<LogLevel>,
    pub search: Option<String>,
    pub trace_id: Option<String>,
    pub service: Option<String>,
    pub exclude_patterns: Option<Vec<String>>,
}

pub fn matches_filter(log: &ParsedLog, filter: &LogFilter) -> bool {
    if let Some(ref level) = filter.level {
        if &log.level != level {
            return false;
        }
    }

    if let Some(ref min_level) = filter.min_level {
        if level_priority(&log.level) < level_priority(min_level) {
            return false;
        }
    }

    if let Some(ref search) = filter.search {
        let term = search.to_lowercase();
        let searchable = format!(
            "{} {} {} {}",
            log.message,
            log.error.as_deref().unwrap_or(""),
            log.service.as_deref().unwrap_or(""),
            serde_json::to_string(&log.extra).unwrap_or_default()
        )
        .to_lowercase();
        if !searchable.contains(&term) {
            return false;
        }
    }

    if let Some(ref trace_id) = filter.trace_id {
        if log.trace_id.as_deref() != Some(trace_id) {
            return false;
        }
    }

    if let Some(ref service) = filter.service {
        if log.service.as_deref() != Some(service) {
            return false;
        }
    }

    if let Some(ref patterns) = filter.exclude_patterns {
        for pattern in patterns {
            if log.message.contains(pattern) {
                return false;
            }
        }
    }

    true
}
