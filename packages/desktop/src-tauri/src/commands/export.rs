use tauri::{command, AppHandle};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::error::KlvError;

/// Abre el diálogo nativo de guardado y escribe `contents` (UTF-8). Devuelve la ruta guardada
/// o `None` si el usuario cancela.
#[command]
pub async fn export_save(
    app: AppHandle,
    default_name: String,
    contents: String,
) -> Result<Option<String>, KlvError> {
    let default_name = default_name.replace(['/', '\\'], "_");

    // El diálogo es asíncrono por callback: no bloquea el runtime mientras el usuario decide.
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(default_name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(selected) = rx
        .await
        .map_err(|_| KlvError::new("El diálogo de guardado se cerró inesperadamente"))?
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| KlvError::new(format!("Ruta de guardado inválida: {e}")))?;

    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&target, contents))
        .await
        .map_err(|e| KlvError::internal(e.to_string()))?
        .map_err(|e| {
            KlvError::new(format!(
                "Error al guardar el archivo \"{}\": {e}",
                path.display()
            ))
        })?;

    Ok(Some(path.to_string_lossy().into_owned()))
}
