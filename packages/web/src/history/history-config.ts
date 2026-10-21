import { BadRequestException, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { assertK8sName } from '@klv/core';
import type { LogLevel } from '@klv/core';
import type { CollectorTarget, HistoryConfig, RetentionSettings } from './history.types';
import { isRecord } from '../type-guards';

export const DEFAULT_RETENTION: RetentionSettings = { maxAgeDays: 7, maxSizeMb: 1024 };

const MAX_TARGETS = 50;
const MAX_SELECTOR_LENGTH = 1024;
const MAX_AGE_DAYS = { min: 1, max: 365 };
const MAX_SIZE_MB = { min: 64, max: 102_400 };
const MAX_EXCLUDE_PATTERNS = 20;
const MAX_EXCLUDE_LENGTH = 200;
const MIN_LEVELS: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

const logger = new Logger('HistoryConfig');

export function configPath(dataDir: string): string {
  return join(dataDir, 'config.json');
}

function optionalString(target: string, field: string, value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${target}: ${field} debe ser un string`);
  return value;
}

function validateMinLevel(label: string, value: unknown): LogLevel | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !MIN_LEVELS.includes(value as LogLevel)) {
    throw new BadRequestException(`${label}: minLevel debe ser uno de ${MIN_LEVELS.join(', ')}`);
  }
  return value as LogLevel;
}

function validateExclude(label: string, value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_EXCLUDE_PATTERNS) {
    throw new BadRequestException(`${label}: exclude debe ser un arreglo de hasta ${MAX_EXCLUDE_PATTERNS} patrones`);
  }
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern.trim() === '' || pattern.length > MAX_EXCLUDE_LENGTH) {
      throw new BadRequestException(
        `${label}: cada patrón de exclude debe ser un string no vacío de hasta ${MAX_EXCLUDE_LENGTH} caracteres`,
      );
    }
  }
  // Una lista vacía equivale a no excluir nada
  return value.length === 0 ? undefined : (value as string[]);
}

const MAX_CONTAINERS = 50;

// Acepta `containers` (arreglo) o el `container` legado (string) cuando `containers` falta
function validateContainers(label: string, containers: unknown, legacy: unknown): string[] | undefined {
  let list: unknown[];
  if (containers != null) {
    if (!Array.isArray(containers)) throw new BadRequestException(`${label}: containers debe ser un arreglo de strings`);
    list = containers;
  } else {
    const single = optionalString(label, 'container', legacy);
    list = single === undefined ? [] : [single];
  }
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') throw new BadRequestException(`${label}: containers debe ser un arreglo de strings`);
    const name = item.trim();
    if (name === '' || result.includes(name)) continue;
    assertK8sName('container', name);
    result.push(name);
  }
  if (result.length > MAX_CONTAINERS) {
    throw new BadRequestException(`${label}: containers admite hasta ${MAX_CONTAINERS} elementos`);
  }
  return result.length === 0 ? undefined : result;
}

function validateRetention(value: unknown): RetentionSettings {
  if (!isRecord(value)) throw new BadRequestException('retention debe ser un objeto');
  const { maxAgeDays, maxSizeMb } = value;
  if (!Number.isInteger(maxAgeDays) || (maxAgeDays as number) < MAX_AGE_DAYS.min || (maxAgeDays as number) > MAX_AGE_DAYS.max) {
    throw new BadRequestException(`retention.maxAgeDays debe ser un entero entre ${MAX_AGE_DAYS.min} y ${MAX_AGE_DAYS.max}`);
  }
  if (!Number.isInteger(maxSizeMb) || (maxSizeMb as number) < MAX_SIZE_MB.min || (maxSizeMb as number) > MAX_SIZE_MB.max) {
    throw new BadRequestException(`retention.maxSizeMb debe ser un entero entre ${MAX_SIZE_MB.min} y ${MAX_SIZE_MB.max}`);
  }
  return { maxAgeDays: maxAgeDays as number, maxSizeMb: maxSizeMb as number };
}

// Valida el cuerpo de PUT /api/history/config y asigna id a los targets nuevos.
// `knownContexts` undefined = no comprobar los contextos contra el kubeconfig (carga de config.json)
export function normalizeConfig(body: unknown, knownContexts: string[] | undefined): HistoryConfig {
  if (!isRecord(body)) throw new BadRequestException('El cuerpo debe ser un objeto JSON');
  if (!Array.isArray(body.targets) || body.targets.length > MAX_TARGETS) {
    throw new BadRequestException(`targets debe ser un arreglo de hasta ${MAX_TARGETS} elementos`);
  }

  const ids = new Set<string>();
  const targets = body.targets.map((raw: unknown, index): CollectorTarget => {
    const label = `targets[${index}]`;
    if (!isRecord(raw)) throw new BadRequestException(`${label} debe ser un objeto`);

    let id: string;
    if (raw.id == null) {
      id = randomUUID();
    } else if (typeof raw.id === 'string' && TARGET_ID.test(raw.id)) {
      id = raw.id;
    } else {
      throw new BadRequestException(`${label}: id inválido`);
    }
    if (ids.has(id)) throw new BadRequestException(`${label}: id duplicado "${id}"`);
    ids.add(id);

    if (typeof raw.context !== 'string' || raw.context === '') {
      throw new BadRequestException(`${label}: context debe ser un string no vacío`);
    }
    if (knownContexts !== undefined && !knownContexts.includes(raw.context)) {
      throw new BadRequestException(`${label}: el contexto "${raw.context}" no existe en el kubeconfig`);
    }
    if (typeof raw.namespace !== 'string') throw new BadRequestException(`${label}: namespace debe ser un string`);
    assertK8sName('namespace', raw.namespace);
    if (typeof raw.enabled !== 'boolean') throw new BadRequestException(`${label}: enabled debe ser un booleano`);

    const containers = validateContainers(label, raw.containers, raw.container);
    const labelSelector = optionalString(label, 'labelSelector', raw.labelSelector);
    if (labelSelector !== undefined && labelSelector.length > MAX_SELECTOR_LENGTH) {
      throw new BadRequestException(`${label}: labelSelector no puede superar ${MAX_SELECTOR_LENGTH} caracteres`);
    }
    const minLevel = validateMinLevel(label, raw.minLevel);
    const exclude = validateExclude(label, raw.exclude);

    return {
      id,
      context: raw.context,
      namespace: raw.namespace,
      ...(containers !== undefined && { containers }),
      ...(labelSelector !== undefined && { labelSelector }),
      enabled: raw.enabled,
      ...(minLevel !== undefined && { minLevel }),
      ...(exclude !== undefined && { exclude }),
    };
  });

  return { targets, retention: validateRetention(body.retention) };
}

// Carga <dataDir>/config.json; si falta o está corrupto se usan los valores por defecto (sin sobrescribir el archivo)
export function loadConfig(dataDir: string): HistoryConfig {
  const path = configPath(dataDir);
  const defaults: HistoryConfig = { targets: [], retention: { ...DEFAULT_RETENTION } };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error(`No se pudo leer ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return defaults;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error('el archivo no contiene un objeto JSON');
    return normalizeConfig(
      { targets: parsed.targets ?? [], retention: parsed.retention ?? DEFAULT_RETENTION },
      undefined,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`Configuración del historial corrupta (${path}), se usan los valores por defecto: ${reason}`);
    return defaults;
  }
}

// Escritura atómica: se escribe <archivo>.tmp y se renombra
export async function saveConfig(dataDir: string, config: HistoryConfig): Promise<void> {
  const path = configPath(dataDir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
