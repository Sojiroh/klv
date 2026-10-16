import { Logger } from '@nestjs/common';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_RETENTION, configPath, normalizeConfig, saveConfig } from './history-config';
import type { HistoryConfig } from './history.types';

const logger = new Logger('HistoryLegacy');

// Lee targets (en orden de posición) y retención del history.db de la v1; el resto del contenido se descarta
function readLegacyConfig(dbPath: string): HistoryConfig {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const targets = db
      .prepare('SELECT id, context, namespace, container, label_selector, enabled FROM targets ORDER BY position')
      .all()
      .map((row) => ({
        id: row.id,
        context: row.context,
        namespace: row.namespace,
        containers: row.container ? [row.container] : undefined,
        labelSelector: row.label_selector ?? undefined,
        enabled: row.enabled === 1,
      }));
    const settings = new Map(
      db.prepare('SELECT key, value FROM settings').all().map((row): [string, number] => [String(row.key), Number(row.value)]),
    );
    return normalizeConfig(
      {
        targets,
        retention: {
          maxAgeDays: settings.get('retention.maxAgeDays') ?? DEFAULT_RETENTION.maxAgeDays,
          maxSizeMb: settings.get('retention.maxSizeMb') ?? DEFAULT_RETENTION.maxSizeMb,
        },
      },
      undefined,
    );
  } finally {
    db.close();
  }
}

// Migra el historial v1 (SQLite): conserva targets y retención en config.json y borra history.db*.
// Si config.json ya existe, los archivos viejos se borran sin leerlos
export async function migrateLegacyHistory(dataDir: string): Promise<void> {
  const dbPath = join(dataDir, 'history.db');
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  if (!files.some((file) => existsSync(file))) return;

  if (!existsSync(configPath(dataDir)) && existsSync(dbPath)) {
    let legacy: HistoryConfig | undefined;
    try {
      legacy = readLegacyConfig(dbPath);
    } catch (err) {
      logger.warn(`No se pudo leer la configuración del historial v1, se usan los valores por defecto: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (legacy !== undefined) await saveConfig(dataDir, legacy);
  }
  await Promise.all(files.map((file) => rm(file, { force: true })));
  logger.log('historial v1 migrado: targets/retención conservados, logs descartados');
}
