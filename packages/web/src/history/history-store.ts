import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { setImmediate as yieldToEventLoop } from 'timers/promises';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { ParsedLog } from '@klv/core';
import type { CollectorTarget, HistoryConfig, HistoryStats, RetentionSettings } from './history.types';

export const DEFAULT_RETENTION: RetentionSettings = { maxAgeDays: 7, maxSizeMb: 1024 };

const BATCH_ROWS = 500;
const BATCH_INTERVAL_MS = 1000;
const DELETE_BATCH = 5000;
const VACUUM_PAGES = 2000;
const STATS_TTL_MS = 5000;
const PRUNE_TARGET_RATIO = 0.9;

// Cada migración lleva el esquema de PRAGMA user_version = índice + 1
const MIGRATIONS: string[] = [
  `
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    context TEXT NOT NULL,
    namespace TEXT NOT NULL,
    pod TEXT NOT NULL,
    container TEXT NOT NULL,
    ts_us INTEGER NOT NULL,
    raw_hash TEXT NOT NULL,
    raw TEXT NOT NULL,
    is_json INTEGER NOT NULL,
    timestamp TEXT,
    k8s_timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    service TEXT,
    trace_id TEXT,
    span_id TEXT,
    caller TEXT,
    error TEXT,
    stack_trace TEXT,
    extra TEXT NOT NULL
  );
  CREATE UNIQUE INDEX logs_dedup ON logs (context, namespace, pod, container, ts_us, raw_hash);
  CREATE INDEX logs_time ON logs (ts_us, id);
  CREATE INDEX logs_ns_container_time ON logs (namespace, container, ts_us, id);
  CREATE INDEX logs_ns_pod_time ON logs (namespace, pod, ts_us, id);
  CREATE VIRTUAL TABLE logs_fts USING fts5(text, content='', contentless_delete=1, tokenize='trigram');
  CREATE TABLE targets (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    context TEXT NOT NULL,
    namespace TEXT NOT NULL,
    container TEXT,
    label_selector TEXT,
    enabled INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  `,
  `
  ALTER TABLE logs ADD COLUMN env TEXT;
  ALTER TABLE logs ADD COLUMN version TEXT;
  `,
];

const INSERT_COLUMNS = [
  'context', 'namespace', 'pod', 'container', 'ts_us', 'raw_hash', 'raw', 'is_json', 'timestamp',
  'k8s_timestamp', 'level', 'message', 'service', 'env', 'version', 'trace_id', 'span_id', 'caller', 'error',
  'stack_trace', 'extra',
];

export interface LogScope {
  context: string;
  namespace: string;
  pod: string;
  container: string;
}

interface PendingRow {
  values: SQLInputValue[];
  searchText: string;
}

type Row = Record<string, SQLOutputValue>;

// Texto sobre el que se evalúan las búsquedas de texto libre (Q1); el índice FTS contiene exactamente este texto.
// Debe mantenerse idéntico al searchText del core (mismo orden de campos)
export function buildSearchText(log: ParsedLog, container: string, namespace: string): string {
  const head = [
    log.message, log.error, log.stackTrace, log.service, log.env, log.version, log.traceId, log.spanId,
    log.caller, log.podName, container, namespace,
  ].filter(Boolean).join('\n');
  return `${head}\n${JSON.stringify(log.extra)}`;
}

// Microsegundos desde epoch del prefijo RFC3339 de kubelet (hasta nanosegundos); null si no es válido.
// Se guardan como entero para no perder precisión (los nanosegundos exceden 2^53).
export function parseKubeletMicros(timestamp: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z?$/.exec(timestamp);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(seconds)) return null;
  const micros = Number((match[2] ?? '').padEnd(6, '0').slice(0, 6));
  return seconds * 1000 + micros;
}

export class HistoryStore {
  readonly path: string;
  private readonly logger = new Logger('HistoryStore');
  private readonly db: DatabaseSync;
  private readonly insertLog: StatementSync;
  private readonly insertFts: StatementSync;
  private queue: PendingRow[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private statsCache: { at: number; stats: HistoryStats } | undefined;
  private closed = false;

  constructor(dataDir: string = process.env.KLV_DATA_DIR ?? join(homedir(), '.klv')) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, 'history.db');
    this.db = new DatabaseSync(this.path);
    // auto_vacuum solo se puede fijar antes de crear tablas
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.insertLog = this.db.prepare(
      `INSERT OR IGNORE INTO logs (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
    );
    this.insertFts = this.db.prepare('INSERT INTO logs_fts (rowid, text) VALUES (?, ?)');
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get();
    const current = Number(row?.user_version ?? 0);
    if (current > MIGRATIONS.length) {
      throw new Error(`La base de datos del historial (${this.path}) es de una versión más reciente de klv`);
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- Inserción por lotes (la cola nunca supera BATCH_ROWS filas) ----

  enqueue(scope: LogScope, log: ParsedLog): void {
    if (this.closed) return;
    const micros = log.k8sTimestamp !== undefined ? parseKubeletMicros(log.k8sTimestamp) : null;
    // Sin prefijo de kubelet válido se usa la hora de recepción
    const tsUs = micros ?? Date.now() * 1000;
    const k8sTimestamp = micros !== null ? log.k8sTimestamp as string : new Date(tsUs / 1000).toISOString();

    this.queue.push({
      values: [
        scope.context, scope.namespace, scope.pod, scope.container, tsUs,
        createHash('sha1').update(log.raw).digest('hex').slice(0, 24),
        log.raw, log.isJson ? 1 : 0, log.timestamp ?? null, k8sTimestamp, log.level, log.message,
        log.service ?? null, log.env ?? null, log.version ?? null, log.traceId ?? null, log.spanId ?? null,
        log.caller ?? null,
        log.error ?? null, log.stackTrace ?? null, JSON.stringify(log.extra),
      ],
      searchText: buildSearchText({ ...log, podName: scope.pod }, scope.container, scope.namespace),
    });

    if (this.queue.length >= BATCH_ROWS) {
      this.flush();
    } else if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => this.flush(), BATCH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  flush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.queue.length === 0 || this.closed) return;
    const rows = this.queue;
    this.queue = [];
    try {
      this.transaction(() => {
        for (const row of rows) {
          const result = this.insertLog.run(...row.values);
          // Las filas duplicadas (reanudación) se ignoran y no se indexan
          if (result.changes > 0) this.insertFts.run(Number(result.lastInsertRowid), row.searchText);
        }
      });
      this.statsCache = undefined;
    } catch (err) {
      this.logger.error(`No se pudo guardar un lote de ${rows.length} líneas: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Último timestamp de kubelet (µs) guardado para un contenedor; null si no hay datos
  lastTimestampUs(scope: LogScope): number | null {
    this.flush();
    const row = this.db
      .prepare('SELECT max(ts_us) AS t FROM logs WHERE context = ? AND namespace = ? AND pod = ? AND container = ?')
      .get(scope.context, scope.namespace, scope.pod, scope.container);
    return typeof row?.t === 'number' ? row.t : null;
  }

  // ---- Consultas ----

  all(sql: string, params: SQLInputValue[]): Row[] {
    this.flush();
    return this.db.prepare(sql).all(...params);
  }

  // ---- Configuración ----

  loadConfig(): HistoryConfig {
    const targets: CollectorTarget[] = this.db
      .prepare('SELECT id, context, namespace, container, label_selector, enabled FROM targets ORDER BY position')
      .all()
      .map((row) => {
        const container = typeof row.container === 'string' ? row.container : undefined;
        const labelSelector = typeof row.label_selector === 'string' ? row.label_selector : undefined;
        return {
          id: String(row.id),
          context: String(row.context),
          namespace: String(row.namespace),
          ...(container !== undefined && { container }),
          ...(labelSelector !== undefined && { labelSelector }),
          enabled: row.enabled === 1,
        };
      });

    const settings = new Map(
      this.db.prepare('SELECT key, value FROM settings').all().map((row): [string, number] => [String(row.key), Number(row.value)]),
    );
    return {
      targets,
      retention: {
        maxAgeDays: settings.get('retention.maxAgeDays') ?? DEFAULT_RETENTION.maxAgeDays,
        maxSizeMb: settings.get('retention.maxSizeMb') ?? DEFAULT_RETENTION.maxSizeMb,
      },
    };
  }

  saveConfig(config: HistoryConfig): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM targets');
      const insertTarget = this.db.prepare(
        'INSERT INTO targets (id, position, context, namespace, container, label_selector, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      config.targets.forEach((target, position) => {
        insertTarget.run(
          target.id, position, target.context, target.namespace,
          target.container ?? null, target.labelSelector ?? null, target.enabled ? 1 : 0,
        );
      });
      const upsert = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      upsert.run('retention.maxAgeDays', String(config.retention.maxAgeDays));
      upsert.run('retention.maxSizeMb', String(config.retention.maxSizeMb));
    });
  }

  // ---- Estadísticas ----

  private pragmaNumber(name: string): number {
    const row = this.db.prepare(`PRAGMA ${name}`).get();
    return Number(row?.[name] ?? 0);
  }

  // El recuento de filas es O(n): se cachea unos segundos
  stats(): HistoryStats {
    this.flush();
    const now = Date.now();
    if (this.statsCache !== undefined && now - this.statsCache.at < STATS_TTL_MS) return this.statsCache.stats;

    const range = this.db.prepare('SELECT min(ts_us) AS oldest, max(ts_us) AS newest, count(*) AS rows FROM logs').get();
    const toIso = (value: SQLOutputValue | undefined): string | undefined =>
      typeof value === 'number' ? new Date(value / 1000).toISOString() : undefined;
    const oldest = toIso(range?.oldest);
    const newest = toIso(range?.newest);
    const stats: HistoryStats = {
      rows: Number(range?.rows ?? 0),
      sizeBytes: this.pragmaNumber('page_count') * this.pragmaNumber('page_size'),
      ...(oldest !== undefined && { oldest }),
      ...(newest !== undefined && { newest }),
    };
    this.statsCache = { at: now, stats };
    return stats;
  }

  // ---- Retención ----

  private usedBytes(): number {
    return (this.pragmaNumber('page_count') - this.pragmaNumber('freelist_count')) * this.pragmaNumber('page_size');
  }

  private deleteRows(select: StatementSync, ...params: SQLInputValue[]): number {
    const ids = select.all(...params).map((row) => Number(row.id));
    if (ids.length === 0) return 0;
    this.transaction(() => {
      const deleteFts = this.db.prepare('DELETE FROM logs_fts WHERE rowid = ?');
      const deleteLog = this.db.prepare('DELETE FROM logs WHERE id = ?');
      for (const id of ids) {
        deleteFts.run(id);
        deleteLog.run(id);
      }
    });
    this.statsCache = undefined;
    return ids.length;
  }

  private async reclaim(): Promise<void> {
    while (!this.closed && this.pragmaNumber('freelist_count') > 0) {
      this.db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
      await yieldToEventLoop();
    }
    if (!this.closed) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  // Borra por antigüedad y luego por tamaño (hasta el 90% del límite), cediendo el event loop entre lotes
  async prune(retention: RetentionSettings, nowMs: number = Date.now()): Promise<void> {
    this.flush();
    const cutoffUs = (nowMs - retention.maxAgeDays * 86_400_000) * 1000;
    const older = this.db.prepare('SELECT id FROM logs WHERE ts_us < ? ORDER BY ts_us, id LIMIT ?');
    while (!this.closed && this.deleteRows(older, cutoffUs, DELETE_BATCH) > 0) await yieldToEventLoop();

    const maxBytes = retention.maxSizeMb * 1024 * 1024;
    if (!this.closed && this.usedBytes() > maxBytes) {
      const oldest = this.db.prepare('SELECT id FROM logs ORDER BY ts_us, id LIMIT ?');
      while (!this.closed && this.usedBytes() > maxBytes * PRUNE_TARGET_RATIO) {
        if (this.deleteRows(oldest, DELETE_BATCH) === 0) break;
        await yieldToEventLoop();
      }
    }
    await this.reclaim();
  }

  async clear(): Promise<void> {
    this.queue = [];
    this.transaction(() => {
      this.db.exec('DELETE FROM logs_fts');
      this.db.exec('DELETE FROM logs');
    });
    this.statsCache = undefined;
    await this.reclaim();
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.db.close();
  }
}
