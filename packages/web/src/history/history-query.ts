import { BadRequestException } from '@nestjs/common';
import { access } from 'fs/promises';
import { setImmediate as yieldToEventLoop } from 'timers/promises';
import { LEVEL_PRIORITY, assertK8sName, matchesQuery, parseLevel, parseLogLine } from '@klv/core';
import type { LogLevel, QueryNode } from '@klv/core';
import { COLUMN_LIST, sqlString } from './history-store';
import type { HistoryStore, Row, SegmentRef, SqlParam } from './history-store';
import { isRecord } from './type-guards';
import type { HistoryLog, HistoryQueryResponse } from './history.types';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const MAX_FILTER_NAMES = 100;
const SCAN_BUDGET = 200_000;
const MAX_PAGE = 5000;
const MAX_QUERY_DEPTH = 64;
// Un chunk agrupa cubos horarios consecutivos hasta este tamaño de Parquet (un cubo nunca se parte)
const CHUNK_BYTES = 256 * 1024 * 1024;

const RESERVED_FIELDS: Record<string, string | undefined> = {
  level: 'level',
  service: 'service',
  env: 'env',
  version: 'version',
  pod: 'pod',
  container: 'container',
  namespace: 'namespace',
  trace: 'trace_id',
  span: 'span_id',
  caller: 'caller',
  message: 'message',
  error: 'error',
};

interface Position {
  tsUs: number;
  id: number;
}

interface Fragment {
  sql: string;
  params: SqlParam[];
}

interface ValidQuery {
  context?: string;
  namespace?: string;
  pods: string[];
  containers: string[];
  fromUs?: number;
  toUs?: number;
  ast: QueryNode | null;
  limit: number;
  before?: Position;
}

// ---- Validación de la petición ----

function validateAst(node: unknown, depth = 0): QueryNode {
  const invalid = (): never => {
    throw new BadRequestException('query: el AST de la consulta no es válido');
  };
  if (depth > MAX_QUERY_DEPTH || !isRecord(node)) return invalid();

  switch (node.type) {
    case 'and':
    case 'or':
      if (!Array.isArray(node.children) || node.children.length < 2) return invalid();
      node.children.forEach((child) => validateAst(child, depth + 1));
      return node as unknown as QueryNode;
    case 'not':
      validateAst(node.child, depth + 1);
      return node as unknown as QueryNode;
    case 'text':
      if (typeof node.value !== 'string' || typeof node.wildcard !== 'boolean') return invalid();
      return node as unknown as QueryNode;
    case 'field': {
      const { field } = node;
      const validField = isRecord(field)
        && ((field.kind === 'reserved' && typeof field.name === 'string' && Object.hasOwn(RESERVED_FIELDS, field.name))
          || (field.kind === 'attr' && typeof field.path === 'string' && field.path !== ''));
      if (!validField) return invalid();
      const numeric = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
      const validOp = node.op === 'exists'
        || (node.op === 'eq' && typeof node.value === 'string' && typeof node.wildcard === 'boolean')
        || (['gt', 'gte', 'lt', 'lte'].includes(node.op as string) && (numeric(node.value) || typeof node.value === 'string'))
        || (node.op === 'range' && numeric(node.min) && numeric(node.max));
      if (!validOp) return invalid();
      return node as unknown as QueryNode;
    }
    default:
      return invalid();
  }
}

function parseTimeBound(name: string, value: unknown): number | undefined {
  if (value == null) return undefined;
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new BadRequestException(`${name} debe ser una fecha ISO-8601 válida`);
  return ms * 1000;
}

function parseNames(name: string, kind: 'pod' | 'container', value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_FILTER_NAMES) {
    throw new BadRequestException(`${name} debe ser un arreglo de hasta ${MAX_FILTER_NAMES} nombres`);
  }
  for (const item of value) {
    if (typeof item !== 'string') throw new BadRequestException(`${name} debe contener solo strings`);
    assertK8sName(kind, item);
  }
  return value as string[];
}

export function encodeCursor(position: Position): string {
  return Buffer.from(JSON.stringify([position.tsUs, position.id])).toString('base64url');
}

function decodeCursor(cursor: string): Position {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) && parsed.length === 2
      && Number.isSafeInteger(parsed[0]) && Number.isSafeInteger(parsed[1])
    ) {
      return { tsUs: parsed[0], id: parsed[1] };
    }
  } catch {
    // cursor mal formado
  }
  throw new BadRequestException('before: cursor inválido');
}

function validateRequest(body: unknown): ValidQuery {
  if (!isRecord(body)) throw new BadRequestException('El cuerpo de la consulta debe ser un objeto JSON');
  const { context, namespace, pods, containers, from, to, query, limit, before } = body;

  if (context != null && (typeof context !== 'string' || context === '')) {
    throw new BadRequestException('context debe ser un string no vacío');
  }
  if (namespace != null) {
    if (typeof namespace !== 'string') throw new BadRequestException('namespace debe ser un string');
    assertK8sName('namespace', namespace);
  }
  if (limit != null && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT)) {
    throw new BadRequestException(`limit debe ser un entero entre 1 y ${MAX_LIMIT}`);
  }
  if (before != null && typeof before !== 'string') throw new BadRequestException('before debe ser un string');

  return {
    context: context as string | undefined,
    namespace: namespace as string | undefined,
    pods: parseNames('pods', 'pod', pods),
    containers: parseNames('containers', 'container', containers),
    fromUs: parseTimeBound('from', from),
    toUs: parseTimeBound('to', to),
    ast: query == null ? null : validateAst(query),
    limit: (limit as number | undefined) ?? DEFAULT_LIMIT,
    before: typeof before === 'string' ? decodeCursor(before) : undefined,
  };
}

// ---- Prefiltro SQL (siempre un SUPERCONJUNTO de lo que acepta matchesQuery) ----

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

// Texto libre = message, error o stack_trace (el mismo conjunto que evalúa matchesQuery)
function likeFragment(value: string): Fragment | null {
  if (!PRINTABLE_ASCII.test(value)) return null;
  const pattern = `%${value.replace(/[\\%_]/g, '\\$&')}%`;
  return {
    sql: `(l.message ILIKE ? ESCAPE '\\' OR l.error ILIKE ? ESCAPE '\\' OR l.stack_trace ILIKE ? ESCAPE '\\')`,
    params: [pattern, pattern, pattern],
  };
}

function levelsMatching(op: 'gt' | 'gte' | 'lt' | 'lte', value: unknown): LogLevel[] {
  const priority = LEVEL_PRIORITY[parseLevel(value)];
  return (Object.keys(LEVEL_PRIORITY) as LogLevel[]).filter((level) => {
    const p = LEVEL_PRIORITY[level];
    if (p < 0) return false;
    return op === 'gt' ? p > priority : op === 'gte' ? p >= priority : op === 'lt' ? p < priority : p <= priority;
  });
}

function fieldFragment(node: Extract<QueryNode, { type: 'field' }>): Fragment | null {
  if (node.field.kind !== 'reserved') return null;
  const column = RESERVED_FIELDS[node.field.name];
  if (column === undefined) return null;

  if (node.field.name === 'level') {
    if (node.op === 'eq') return { sql: 'l.level = ?', params: [node.value] };
    if (node.op === 'gt' || node.op === 'gte' || node.op === 'lt' || node.op === 'lte') {
      const levels = levelsMatching(node.op, node.value);
      if (levels.length === 0) return { sql: '0', params: [] };
      return { sql: `l.level IN (${levels.map(() => '?').join(', ')})`, params: levels };
    }
    return null;
  }

  if (node.op === 'exists') return { sql: `(l.${column} IS NOT NULL AND l.${column} <> '')`, params: [] };
  if (node.op === 'eq' && !node.wildcard && PRINTABLE_ASCII.test(node.value)) {
    return { sql: `lower(l.${column}) = lower(?)`, params: [node.value] };
  }
  return null;
}

function textFragment(node: Extract<QueryNode, { type: 'text' }>): Fragment | null {
  if (!node.wildcard) return likeFragment(node.value);
  // Glob: cada tramo literal debe aparecer; se usa el más largo
  const longest = node.value.split('*').reduce((best, part) => (part.length > best.length ? part : best), '');
  return likeFragment(longest);
}

// null = sin restricción (TRUE)
function prefilter(node: QueryNode | null): Fragment | null {
  if (node === null) return null;
  switch (node.type) {
    case 'text':
      return textFragment(node);
    case 'field':
      return fieldFragment(node);
    case 'and': {
      const parts = node.children.map(prefilter).filter((part): part is Fragment => part !== null);
      if (parts.length === 0) return null;
      return { sql: `(${parts.map((p) => p.sql).join(' AND ')})`, params: parts.flatMap((p) => p.params) };
    }
    case 'or': {
      const parts = node.children.map(prefilter);
      if (parts.some((part) => part === null)) return null;
      const fragments = parts as Fragment[];
      return { sql: `(${fragments.map((p) => p.sql).join(' OR ')})`, params: fragments.flatMap((p) => p.params) };
    }
    case 'not':
      // La negación de un superconjunto no es un superconjunto
      return null;
  }
}

// ---- Ejecución ----

// Reconstruye el log completo desde la línea guardada (`extra`, `timestamp` e `isJson` no se persisten)
function rowToLog(row: Row): HistoryLog {
  const pod = row.pod as string;
  return {
    ...parseLogLine(row.raw as string, pod),
    k8sTimestamp: row.k8s_timestamp as string,
    podName: pod,
    context: row.context as string,
    namespace: row.namespace as string,
    container: row.container as string,
  };
}

// Condiciones de ámbito, rango temporal y prefiltro (sin la paginación keyset)
function buildFilter(request: ValidQuery): Fragment {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (request.context !== undefined) {
    conditions.push('l.context = ?');
    params.push(request.context);
  }
  if (request.namespace !== undefined) {
    conditions.push('l.namespace = ?');
    params.push(request.namespace);
  }
  if (request.pods.length > 0) {
    conditions.push(`l.pod IN (${request.pods.map(() => '?').join(', ')})`);
    params.push(...request.pods);
  }
  if (request.containers.length > 0) {
    conditions.push(`l.container IN (${request.containers.map(() => '?').join(', ')})`);
    params.push(...request.containers);
  }
  if (request.fromUs !== undefined) {
    conditions.push('l.ts_us >= ?');
    params.push(request.fromUs);
  }
  if (request.toUs !== undefined) {
    conditions.push('l.ts_us < ?');
    params.push(request.toUs);
  }
  const filter = prefilter(request.ast);
  if (filter !== null) {
    conditions.push(filter.sql);
    params.push(...filter.params);
  }
  return { sql: conditions.length > 0 ? conditions.join(' AND ') : 'TRUE', params };
}

// Tramo de tiempo [startUs, endUs) con los segmentos Parquet que contiene; los chunks cubren todo el eje
// (el más nuevo no tiene fin y el más antiguo no tiene inicio) para que `current` nunca quede fuera
interface Chunk {
  startUs: number;
  endUs: number;
  files: string[];
}

// `segments` llega ordenado de más nuevo a más antiguo; un cubo (varios archivos posibles) nunca se parte
function buildChunks(segments: SegmentRef[]): Chunk[] {
  const buckets = new Map<number, { bytes: number; files: string[] }>();
  for (const segment of segments) {
    const bucket = buckets.get(segment.bucketUs) ?? { bytes: 0, files: [] };
    bucket.bytes += segment.bytes;
    bucket.files.push(segment.path);
    buckets.set(segment.bucketUs, bucket);
  }

  const chunks: Chunk[] = [];
  let bytes = 0;
  for (const [bucketUs, bucket] of buckets) {
    if (chunks.length === 0 || bytes + bucket.bytes > CHUNK_BYTES) {
      chunks.push({ startUs: bucketUs, endUs: Number.POSITIVE_INFINITY, files: [] });
      bytes = 0;
    }
    const chunk = chunks[chunks.length - 1];
    chunk.startUs = bucketUs;
    chunk.files.push(...bucket.files);
    bytes += bucket.bytes;
  }
  if (chunks.length === 0) chunks.push({ startUs: Number.NEGATIVE_INFINITY, endUs: Number.POSITIVE_INFINITY, files: [] });
  for (let i = 1; i < chunks.length; i++) chunks[i].endUs = chunks[i - 1].startUs;
  chunks[chunks.length - 1].startUs = Number.NEGATIVE_INFINITY;
  return chunks;
}

async function chunkSql(chunk: Chunk, filterSql: string): Promise<string> {
  const range: string[] = [];
  if (Number.isFinite(chunk.startUs)) range.push(`ts_us >= ${chunk.startUs}`);
  if (Number.isFinite(chunk.endUs)) range.push(`ts_us < ${chunk.endUs}`);
  const arms = [`SELECT ${COLUMN_LIST} FROM current WHERE ${range.length > 0 ? range.join(' AND ') : 'TRUE'}`];

  // Un segmento puede haberse borrado por retención desde que se listó
  const present: string[] = [];
  for (const file of chunk.files) {
    if (await access(file).then(() => true, () => false)) present.push(file);
  }
  if (present.length > 0) arms.push(`SELECT ${COLUMN_LIST} FROM read_parquet([${present.map(sqlString).join(', ')}])`);

  return `SELECT ${COLUMN_LIST} FROM (${arms.join(' UNION ALL ')}) l
    WHERE ${filterSql} AND (l.ts_us < ? OR (l.ts_us = ? AND l.id < ?))
    ORDER BY l.ts_us DESC, l.id DESC LIMIT ?`;
}

// Devuelve las `limit` coincidencias más recientes (orden ascendente) recorriendo los chunks del más nuevo al más
// antiguo por páginas keyset, cediendo el event loop entre páginas
export async function queryHistory(store: HistoryStore, body: unknown): Promise<HistoryQueryResponse> {
  const request = validateRequest(body);
  const filter = buildFilter(request);
  // Que las líneas recién recibidas ya sean visibles
  await store.flush();

  return store.read(async (reader) => {
    const chunks = buildChunks(await store.listSegments(reader, request.fromUs, request.toUs));
    let position: Position = request.before ?? { tsUs: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
    const matches: HistoryLog[] = [];
    let scanned = 0;
    let pageSize = Math.min(Math.max(request.limit, 100), MAX_PAGE);
    let nextCursor: string | null = null;
    let truncated = false;

    scan: for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      // Los chunks más nuevos que el cursor o que `to` solo tienen filas descartadas
      if (chunk.startUs > position.tsUs) continue;
      if (request.toUs !== undefined && chunk.startUs >= request.toUs) continue;
      // Los siguientes son aún más antiguos que `from`
      if (request.fromUs !== undefined && chunk.endUs <= request.fromUs) break;

      const sql = await chunkSql(chunk, filter.sql);
      const hasOlder = c < chunks.length - 1;
      while (true) {
        const size = Math.min(pageSize, SCAN_BUDGET - scanned);
        const rows = await reader.all(sql, [...filter.params, position.tsUs, position.tsUs, position.id, size]);

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          scanned++;
          position = { tsUs: Number(row.ts_us), id: Number(row.id) };
          const log = rowToLog(row);
          if (!matchesQuery(log, request.ast)) continue;

          matches.push(log);
          if (matches.length === request.limit) {
            // Quedan filas por revisar salvo que este sea el final de los datos
            if (i < rows.length - 1 || rows.length === size || hasOlder) nextCursor = encodeCursor(position);
            break scan;
          }
        }

        // Página incompleta: chunk agotado, sigue el siguiente (más antiguo) con el mismo cursor
        if (rows.length < size) break;
        if (scanned >= SCAN_BUDGET) {
          truncated = true;
          nextCursor = encodeCursor(position);
          break scan;
        }
        pageSize = Math.min(pageSize * 2, MAX_PAGE);
        await yieldToEventLoop();
      }

      if (scanned >= SCAN_BUDGET && hasOlder) {
        truncated = true;
        nextCursor = encodeCursor(position);
        break;
      }
    }

    return { logs: matches.reverse(), nextCursor, scanned, truncated };
  });
}
