pub mod commands;
pub mod error;
pub mod parser;
pub mod state;

use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let client = tauri::async_runtime::block_on(async {
                kube::Client::try_default().await.ok()
            });
            let state = AppState::new(client);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::contexts::get_contexts,
            commands::contexts::set_context,
            commands::namespaces::get_namespaces,
            commands::pods::get_pods,
            commands::deployments::get_deployments,
            commands::logs::get_pod_logs,
            commands::logs::get_container_logs,
            commands::logs::stream_start,
            commands::logs::stream_stop,
        ])
        .run(tauri::generate_context!())
        .expect("Error al iniciar la aplicación");
}
