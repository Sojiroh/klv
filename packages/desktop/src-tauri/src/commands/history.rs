use tauri::{command, State};

use crate::error::KlvError;
use crate::history::types::{
    HistoryConfig, HistoryConfigInput, HistoryQueryRequest, HistoryQueryResponse, HistoryStatus,
};
use crate::history::HistoryState;

#[command]
pub async fn history_get_config(
    history: State<'_, HistoryState>,
) -> Result<HistoryConfig, KlvError> {
    history.service()?.get_config().await
}

#[command]
pub async fn history_set_config(
    history: State<'_, HistoryState>,
    config: HistoryConfigInput,
) -> Result<HistoryConfig, KlvError> {
    history.service()?.set_config(config).await
}

#[command]
pub async fn history_status(history: State<'_, HistoryState>) -> Result<HistoryStatus, KlvError> {
    history.service()?.status().await
}

#[command]
pub async fn history_query(
    history: State<'_, HistoryState>,
    request: HistoryQueryRequest,
) -> Result<HistoryQueryResponse, KlvError> {
    history.service()?.query(request).await
}

#[command]
pub async fn history_clear(history: State<'_, HistoryState>) -> Result<(), KlvError> {
    history.service()?.clear().await
}
