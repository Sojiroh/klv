import { Logger } from '@nestjs/common';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import { mkdirSync } from 'fs';
import { readdir, rename, rm, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { ParsedLog } from '@klv/core';
import type { HistoryStats, RetentionSettings } from './history.types';

const BATCH_ROWS = 500;
const BATCH_INTERVAL_MS = 1000;
const STATS_TTL_MS = 5000;
// Cubo de rollover = hora UTC; las líneas tardías de la hora abierta esperan este margen antes de exportarse
const HOUR_US = 3_600_000_000;
const ROLLOVER_GRACE_US = 120_000_000;
const ROW_GROUP_SIZE = 122_880;

// Orden de columnas idéntico en `current` y en cada archivo Parquet (importa para COPY y el appender)
export const COLUMN_LIST = [
  'id', 'ts_us', 'context', 'namespace', 'pod', 'container', 'k8s_timestamp', 'level', 'service', 'env', 'version',
  'trace_id', 'span_id', 'caller', 'message', 'error', 'stack_trace', 'raw',
].join(', ');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS current (
    id BIGINT NOT NULL, ts_us BIGINT NOT NULL,
    context VARCHAR NOT NULL, namespace VARCHAR NOT NULL, pod VARCHAR NOT NULL, container VARCHAR NOT NULL,
    k8s_timestamp VARCHAR NOT NULL, level VARCHAR NOT NULL,
    service VARCHAR, env VARCHAR, version VARCHAR, trace_id VARCHAR, span_id VARCHAR, caller VARCHAR,
    message VARCHAR NOT NULL, error VARCHAR, stack_trace VARCHAR,
    raw VARCHAR NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS segments (
    id BIGINT PRIMARY KEY, bucket_us BIGINT, file VARCHAR, rows BIGINT, bytes BIGINT,
    min_ts_us BIGINT, max_ts_us BIGINT, min_id BIGINT, max_id BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS streams (
    context VARCHAR, namespace VARCHAR, pod VARCHAR, container VARCHAR, last_ts_us BIGINT,
    PRIMARY KEY (context, namespace, pod, container)
  )`,
];

export interface LogScope {
  context: string;
  namespace: string;
  pod: string;
  container: string;
}

export type SqlParam = string | number;
export type Row = Record<string, DuckDBValue>;

// Consultas de solo lectura sobre una instantánea consistente (ver HistoryStore.read)
export interface Reader {
  all(sql: string, params?: SqlParam[]): Promise<Row[]>;
}

export interface SegmentRef {
  bucketUs: number;
  bytes: number;
  path: string;
}

interface PendingRow {
  scope: LogScope;
  tsUs: number;
  k8sTimestamp: string;
  log: ParsedLog;
}

// Ejecuta tareas de una en una en el orden de llegada; un fallo no bloquea a las siguientes
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export function resolveDataDir(): string {
  return process.env.KLV_DATA_DIR ?? join(homedir(), '.klv');
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

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function scopeKey(scope: LogScope): string {
  return JSON.stringify([scope.context, scope.namespace, scope.pod, scope.container]);
}

export class HistoryStore {
  readonly path: string;
  private readonly logger = new Logger('HistoryStore');
  private readonly segmentsDir: string;
  // Transacciones de escritura sobre la conexión `writer`
  private readonly writeLock = new Mutex();
  // rollover / prune / clear no se solapan entre sí (sí con ingesta y consultas)
  private readonly maintenanceLock = new Mutex();
  private queue: PendingRow[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private statsCache: { at: number; stats: HistoryStats } | undefined;
  private nextId = 1;
  private nextSegmentId = 1;
  private closed = false;

  private constructor(
    dataDir: string,
    private readonly instance: DuckDBInstance,
    private readonly writer: DuckDBConnection,
  ) {
    this.path = join(dataDir, 'history.duckdb');
    this.segmentsDir = join(dataDir, 'segments');
  }

  static async open(dataDir: string = resolveDataDir()): Promise<HistoryStore> {
    mkdirSync(join(dataDir, 'segments'), { recursive: true, mode: 0o700 });
    const instance = await DuckDBInstance.create(join(dataDir, 'history.duckdb'), { memory_limit: '1GB', threads: '4' });
    const writer = await instance.connect();
    const store = new HistoryStore(dataDir, instance, writer);
    try {
      await store.init();
    } catch (err) {
      writer.closeSync();
      instance.closeSync();
      throw err;
    }
    return store;
  }

  private async init(): Promise<void> {
    for (const ddl of SCHEMA) await this.writer.run(ddl);
    await this.recoverSegments();

    const [ids] = await this.all(
      `SELECT coalesce((SELECT max(id) FROM current), 0) AS current_id,
              coalesce((SELECT max(max_id) FROM segments), 0) AS segment_max_id,
              coalesce((SELECT max(id) FROM segments), 0) AS segment_id`,
    );
    this.nextId = Math.max(Number(ids.current_id), Number(ids.segment_max_id)) + 1;
    this.nextSegmentId = Number(ids.segment_id) + 1;
  }

  // Recuperación tras un cierre abrupto: .tmp huérfanos, Parquet sin fila en `segments` (sus filas siguen en
  // `current`) y filas de `segments` cuyo archivo desapareció
  private async recoverSegments(): Promise<void> {
    const registered = await this.all('SELECT id, file FROM segments');
    const known = new Set(registered.map((row) => String(row.file)));
    const present = new Set<string>();
    for (const name of await readdir(this.segmentsDir)) {
      if (name.endsWith('.tmp') || (name.endsWith('.parquet') && !known.has(name))) {
        await rm(join(this.segmentsDir, name), { force: true });
        this.logger.log(`Segmento huérfano eliminado: ${name}`);
      } else {
        present.add(name);
      }
    }
    for (const row of registered) {
      if (present.has(String(row.file))) continue;
      this.logger.warn(`Falta el segmento ${String(row.file)}: se elimina su registro`);
      await this.writer.run('DELETE FROM segments WHERE id = ?', [Number(row.id)]);
    }
  }

  // ---- Inserción por lotes ----

  // Síncrono para quien llama: encola en memoria y programa el volcado a `current`
  enqueue(scope: LogScope, log: ParsedLog): void {
    if (this.closed) return;
    const micros = log.k8sTimestamp !== undefined ? parseKubeletMicros(log.k8sTimestamp) : null;
    // Sin prefijo de kubelet válido se usa la hora de recepción
    const tsUs = micros ?? Date.now() * 1000;
    const k8sTimestamp = micros !== null ? log.k8sTimestamp as string : new Date(tsUs / 1000).toISOString();
    this.queue.push({ scope, tsUs, k8sTimestamp, log });

    if (this.queue.length >= BATCH_ROWS) {
      void this.flush();
    } else if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => void this.flush(), BATCH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  // Un volcado a la vez; la cola se toma al empezar, así recoge lo encolado mientras esperaba. Nunca rechaza.
  flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    return this.writeLock.run(async () => {
      if (this.queue.length === 0 || this.closed) return;
      const rows = this.queue;
      this.queue = [];
      try {
        await this.insertRows(rows);
        this.statsCache = undefined;
      } catch (err) {
        this.logger.error(`No se pudo guardar un lote de ${rows.length} líneas: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private async rollback(): Promise<void> {
    await this.writer.run('ROLLBACK').catch(() => undefined);
  }

  // Una transacción: appender sobre `current` + upsert de `streams` por cada contenedor del lote
  private async insertRows(rows: PendingRow[]): Promise<void> {
    await this.writer.run('BEGIN TRANSACTION');
    try {
      const appender = await this.writer.createAppender('current');
      const lastBySource = new Map<string, { scope: LogScope; tsUs: number }>();
      try {
        const text = (value: string | undefined): void => {
          if (value === undefined) appender.appendNull();
          else appender.appendVarchar(value);
        };
        for (const { scope, tsUs, k8sTimestamp, log } of rows) {
          appender.appendBigInt(BigInt(this.nextId++));
          appender.appendBigInt(BigInt(tsUs));
          appender.appendVarchar(scope.context);
          appender.appendVarchar(scope.namespace);
          appender.appendVarchar(scope.pod);
          appender.appendVarchar(scope.container);
          appender.appendVarchar(k8sTimestamp);
          appender.appendVarchar(log.level);
          text(log.service);
          text(log.env);
          text(log.version);
          text(log.traceId);
          text(log.spanId);
          text(log.caller);
          appender.appendVarchar(log.message);
          text(log.error);
          text(log.stackTrace);
          appender.appendVarchar(log.raw);
          appender.endRow();

          const key = scopeKey(scope);
          const previous = lastBySource.get(key);
          if (previous === undefined || tsUs > previous.tsUs) lastBySource.set(key, { scope, tsUs });
        }
        appender.flushSync();
      } finally {
        appender.closeSync();
      }

      for (const { scope, tsUs } of lastBySource.values()) {
        await this.writer.run(
          `INSERT INTO streams (context, namespace, pod, container, last_ts_us) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (context, namespace, pod, container) DO UPDATE SET last_ts_us = greatest(last_ts_us, excluded.last_ts_us)`,
          [scope.context, scope.namespace, scope.pod, scope.container, tsUs],
        );
      }
      await this.writer.run('COMMIT');
    } catch (err) {
      await this.rollback();
      throw err;
    }
  }

  // Último timestamp de kubelet (µs) guardado (o aún en cola) para un contenedor; null si no hay datos
  async lastTimestampUs(scope: LogScope): Promise<number | null> {
    let last: number | null = null;
    for (const row of this.queue) {
      if (row.scope.context === scope.context && row.scope.namespace === scope.namespace
        && row.scope.pod === scope.pod && row.scope.container === scope.container) {
        last = last === null ? row.tsUs : Math.max(last, row.tsUs);
      }
    }
    const rows = await this.all(
      'SELECT last_ts_us FROM streams WHERE context = ? AND namespace = ? AND pod = ? AND container = ?',
      [scope.context, scope.namespace, scope.pod, scope.container],
    );
    if (rows.length > 0 && rows[0].last_ts_us !== null) {
      const stored = Number(rows[0].last_ts_us);
      last = last === null ? stored : Math.max(last, stored);
    }
    return last;
  }

  // ---- Lectura (conexiones propias: no bloquean ni son bloqueadas por la de escritura) ----

  async all(sql: string, params?: SqlParam[]): Promise<Row[]> {
    const conn = await this.instance.connect();
    try {
      return (await conn.runAndReadAll(sql, params)).getRowObjects();
    } finally {
      conn.closeSync();
    }
  }

  // Todas las consultas de `fn` ven la misma instantánea de `current` y `segments`, aunque haya un rollover en curso
  async read<T>(fn: (reader: Reader) => Promise<T>): Promise<T> {
    const conn = await this.instance.connect();
    try {
      await conn.run('BEGIN TRANSACTION');
      return await fn({ all: async (sql, params) => (await conn.runAndReadAll(sql, params)).getRowObjects() });
    } finally {
      // Cerrar la conexión descarta la transacción de solo lectura
      conn.closeSync();
    }
  }

  // Segmentos que solapan [fromUs, toUs), del más reciente al más antiguo
  async listSegments(reader: Reader, fromUs?: number, toUs?: number): Promise<SegmentRef[]> {
    const conditions: string[] = [];
    const params: SqlParam[] = [];
    if (fromUs !== undefined) {
      conditions.push('max_ts_us >= ?');
      params.push(fromUs);
    }
    if (toUs !== undefined) {
      conditions.push('min_ts_us < ?');
      params.push(toUs);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await reader.all(
      `SELECT bucket_us, file, bytes FROM segments ${where} ORDER BY bucket_us DESC, id DESC`,
      params,
    );
    return rows.map((row) => ({
      bucketUs: Number(row.bucket_us),
      bytes: Number(row.bytes),
      path: join(this.segmentsDir, String(row.file)),
    }));
  }

  // ---- Rollover: `current` → segmentos Parquet horarios ----

  rollover(): Promise<void> {
    return this.maintenanceLock.run(() => this.exportClosedBuckets());
  }

  private async exportClosedBuckets(): Promise<void> {
    if (this.closed) return;
    const limit = Math.floor((Date.now() * 1000 - ROLLOVER_GRACE_US) / HOUR_US) * HOUR_US;
    const buckets = await this.all(
      `SELECT ts_us - ts_us % ${HOUR_US} AS bucket FROM current WHERE ts_us < ? GROUP BY 1 ORDER BY 1`,
      [limit],
    );
    let exported = false;
    for (const row of buckets) {
      const bucketUs = Number(row.bucket);
      try {
        exported = await this.exportBucket(bucketUs) || exported;
      } catch (err) {
        this.logger.error(`No se pudo exportar el segmento ${this.bucketStamp(bucketUs)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (exported) await this.checkpoint();
  }

  private bucketStamp(bucketUs: number): string {
    return new Date(bucketUs / 1000).toISOString().slice(0, 13).replaceAll('-', '');
  }

  // Exporta las filas del cubo con id <= maxId (instantánea); las añadidas después quedan para el siguiente rollover
  private async exportBucket(bucketUs: number): Promise<boolean> {
    const inBucket = `ts_us >= ${bucketUs} AND ts_us < ${bucketUs + HOUR_US}`;
    const [top] = await this.all(`SELECT max(id) AS max_id FROM current WHERE ${inBucket}`);
    if (top.max_id === null) return false;
    const maxId = Number(top.max_id);
    const selection = `${inBucket} AND id <= ${maxId}`;

    const [stats] = await this.all(
      `SELECT count(*) AS rows, min(ts_us) AS min_ts, max(ts_us) AS max_ts, min(id) AS min_id FROM current WHERE ${selection}`,
    );
    const segmentId = this.nextSegmentId++;
    const file = `${this.bucketStamp(bucketUs)}-${segmentId}.parquet`;
    const finalPath = join(this.segmentsDir, file);
    const tmpPath = `${finalPath}.tmp`;

    // Conexión propia: la ingesta sigue escribiendo en `current` mientras se comprime
    const conn = await this.instance.connect();
    try {
      await conn.run(
        `COPY (SELECT ${COLUMN_LIST} FROM current WHERE ${selection} ORDER BY ts_us, id)
         TO ${sqlString(tmpPath)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`,
      );
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    } finally {
      conn.closeSync();
    }
    await rename(tmpPath, finalPath);
    const { size } = await stat(finalPath);

    try {
      await this.writeLock.run(async () => {
        await this.writer.run('BEGIN TRANSACTION');
        try {
          await this.writer.run(
            'INSERT INTO segments (id, bucket_us, file, rows, bytes, min_ts_us, max_ts_us, min_id, max_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [segmentId, bucketUs, file, Number(stats.rows), size, Number(stats.min_ts), Number(stats.max_ts), Number(stats.min_id), maxId],
          );
          await this.writer.run(`DELETE FROM current WHERE ${selection}`);
          await this.writer.run('COMMIT');
        } catch (err) {
          await this.rollback();
          throw err;
        }
      });
    } catch (err) {
      await rm(finalPath, { force: true });
      throw err;
    }
    this.statsCache = undefined;
    return true;
  }

  private async checkpoint(): Promise<void> {
    try {
      await this.writeLock.run(() => this.writer.run('CHECKPOINT'));
    } catch (err) {
      this.logger.warn(`CHECKPOINT no completado: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Estadísticas ----

  private async databaseBytes(): Promise<number> {
    let total = 0;
    for (const file of [this.path, `${this.path}.wal`]) {
      try {
        total += (await stat(file)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return total;
  }

  // El recuento y los rangos recorren columnas de `current`: se cachea unos segundos
  async stats(): Promise<HistoryStats> {
    const now = Date.now();
    if (this.statsCache !== undefined && now - this.statsCache.at < STATS_TTL_MS) return this.statsCache.stats;

    const [segments] = await this.all(
      'SELECT coalesce(sum(rows), 0) AS rows, coalesce(sum(bytes), 0) AS bytes, min(min_ts_us) AS oldest, max(max_ts_us) AS newest FROM segments',
    );
    const [current] = await this.all('SELECT count(*) AS rows, min(ts_us) AS oldest, max(ts_us) AS newest FROM current');
    const bounds = (key: 'oldest' | 'newest', pick: (a: number, b: number) => number): string | undefined => {
      const values = [segments[key], current[key]].filter((value) => value !== null).map(Number);
      return values.length > 0 ? new Date(values.reduce((a, b) => pick(a, b)) / 1000).toISOString() : undefined;
    };
    const oldest = bounds('oldest', Math.min);
    const newest = bounds('newest', Math.max);
    const stats: HistoryStats = {
      rows: Number(segments.rows) + Number(current.rows),
      sizeBytes: Number(segments.bytes) + await this.databaseBytes(),
      ...(oldest !== undefined && { oldest }),
      ...(newest !== undefined && { newest }),
    };
    this.statsCache = { at: now, stats };
    return stats;
  }

  // ---- Retención ----

  // Borra un segmento: primero su registro (una transacción mínima) y luego el archivo
  private async dropSegment(id: number, file: string): Promise<void> {
    await this.writeLock.run(() => this.writer.run('DELETE FROM segments WHERE id = ?', [id]));
    await rm(join(this.segmentsDir, file), { force: true });
    this.statsCache = undefined;
  }

  // Por antigüedad y luego por tamaño (el más antiguo primero); borrar archivos no bloquea la ingesta ni las consultas.
  // Tras podar se exporta lo que ya esté cerrado en `current`
  async prune(retention: RetentionSettings, nowMs: number = Date.now()): Promise<void> {
    await this.maintenanceLock.run(() => this.deleteExpired(retention, nowMs));
    await this.rollover();
  }

  private async deleteExpired(retention: RetentionSettings, nowMs: number): Promise<void> {
    if (this.closed) return;
    const cutoffUs = (nowMs - retention.maxAgeDays * 86_400_000) * 1000;
    let deleted = false;

    const expired = await this.all('SELECT id, file FROM segments WHERE max_ts_us < ? ORDER BY bucket_us, id', [cutoffUs]);
    for (const segment of expired) {
      await this.dropSegment(Number(segment.id), String(segment.file));
      deleted = true;
    }
    const removed = await this.writeLock.run(async () => {
      const result = await this.writer.run('DELETE FROM current WHERE ts_us < ?', [cutoffUs]);
      await this.writer.run('DELETE FROM streams WHERE last_ts_us < ?', [cutoffUs]);
      return result.rowsChanged;
    });
    if (removed > 0) {
      deleted = true;
      this.statsCache = undefined;
    }

    const maxBytes = retention.maxSizeMb * 1024 * 1024;
    const [total] = await this.all('SELECT coalesce(sum(bytes), 0) AS bytes FROM segments');
    let segmentBytes = Number(total.bytes);
    const fixedBytes = await this.databaseBytes();
    while (!this.closed && fixedBytes + segmentBytes > maxBytes) {
      const [oldest] = await this.all('SELECT id, file, bytes FROM segments ORDER BY bucket_us ASC, id ASC LIMIT 1');
      if (oldest === undefined) break;
      await this.dropSegment(Number(oldest.id), String(oldest.file));
      segmentBytes -= Number(oldest.bytes);
      deleted = true;
    }

    if (deleted) await this.checkpoint();
  }

  async clear(): Promise<void> {
    await this.maintenanceLock.run(async () => {
      this.queue = [];
      await this.writeLock.run(async () => {
        await this.writer.run('BEGIN TRANSACTION');
        try {
          await this.writer.run('DELETE FROM segments');
          await this.writer.run('DELETE FROM current');
          await this.writer.run('DELETE FROM streams');
          await this.writer.run('COMMIT');
        } catch (err) {
          await this.rollback();
          throw err;
        }
      });
      for (const name of await readdir(this.segmentsDir)) await rm(join(this.segmentsDir, name), { force: true });
      this.statsCache = undefined;
      await this.checkpoint();
    });
  }

  // Cierre ordenado: vuelca la cola, exporta lo cerrado, CHECKPOINT y libera DuckDB
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    try {
      await this.rollover();
    } catch (err) {
      this.logger.error(`Rollover final fallido: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.checkpoint();
    this.closed = true;
    this.writer.closeSync();
    this.instance.closeSync();
  }
}
