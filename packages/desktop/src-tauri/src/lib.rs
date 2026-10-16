pub mod commands;
pub mod error;
pub mod history;
pub mod names;
pub mod parser;
pub mod query;
pub mod state;

use state::AppState;
use tauri::Manager;
use history::HistoryState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let client = tauri::async_runtime::block_on(async {
                kube::Client::try_default()
                    .await
                    .map_err(|e| e.to_string())
            });
            let state = AppState::new(client);
            app.manage(state);
            let history = tauri::async_runtime::block_on(HistoryState::start(
                app.path().app_data_dir().map_err(|e| e.to_string()),
            ));
            app.manage(history);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::contexts::get_contexts,
            commands::contexts::set_context,
            commands::namespaces::get_namespaces,
            commands::pods::get_pods,
            commands::pods::get_containers,
            commands::deployments::get_deployments,
            commands::logs::get_pod_logs,
            commands::logs::get_container_logs,
            commands::logs::stream_start,
            commands::logs::stream_stop,
            commands::export::export_save,
            commands::history::history_get_config,
            commands::history::history_set_config,
            commands::history::history_status,
            commands::history::history_query,
            commands::history::history_clear,
        ])
        .build(tauri::generate_context!())
        .expect("Error al iniciar la aplicación")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(history) = app.try_state::<HistoryState>() {
                    tauri::async_runtime::block_on(history.shutdown());
                }
            }
        });
}
