//! Migración del historial v1 (`history.db`, SQLite): se conservan targets y retención en
//! `config.json` y se descartan los logs. Único uso de `rusqlite`.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use super::db::DbResult;
use super::service::write_config_file;
use super::types::{CollectorTarget, HistoryConfig, RetentionSettings, DEFAULT_RETENTION};
use crate::error::KlvError;

const LEGACY_FILES: [&str; 3] = ["history.db", "history.db-wal", "history.db-shm"];

fn read_config(db_path: &Path) -> rusqlite::Result<HistoryConfig> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT id, context, namespace, container, label_selector, enabled
         FROM targets ORDER BY position",
    )?;
    let targets = stmt
        .query_map([], |r| {
            Ok(CollectorTarget {
                id: r.get(0)?,
                context: r.get(1)?,
                namespace: r.get(2)?,
                containers: r
                    .get::<_, Option<String>>(3)?
                    .filter(|c| !c.is_empty())
                    .map(|c| vec![c]),
                label_selector: r.get(4)?,
                enabled: r.get(5)?,
                min_level: None,
                exclude: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let retention = conn
        .query_row(
            "SELECT max_age_days, max_size_mb FROM retention WHERE id = 1",
            [],
            |r| {
                Ok(RetentionSettings {
                    max_age_days: r.get(0)?,
                    max_size_mb: r.get(1)?,
                })
            },
        )
        .optional()?
        .unwrap_or(DEFAULT_RETENTION);
    Ok(HistoryConfig { targets, retention })
}

fn remove_legacy_files(dir: &Path) -> DbResult<()> {
    for name in LEGACY_FILES {
        let path = dir.join(name);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(KlvError::new(format!("{}: {e}", path.display()))),
        }
    }
    Ok(())
}

/// Si queda un `history.db` de la versión anterior: sin `config.json` se migra su
/// configuración; con `config.json` se borra sin leerlo.
pub fn migrate_v1(dir: &Path, config_path: &Path) -> DbResult<()> {
    let legacy = dir.join("history.db");
    if !legacy.exists() {
        return Ok(());
    }
    if !config_path.exists() {
        match read_config(&legacy) {
            Ok(config) => {
                write_config_file(config_path, &config)?;
                eprintln!("Historial: historial v1 migrado: targets/retención conservados, logs descartados");
            }
            // Una base v1 ilegible no tiene configuración que conservar.
            Err(e) => eprintln!("Historial: no se pudo leer la configuración del historial v1 ({e}); se descarta"),
        }
    }
    remove_legacy_files(dir)
}
