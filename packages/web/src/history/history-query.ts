import { BadRequestException } from '@nestjs/common';
import { setImmediate as yieldToEventLoop } from 'timers/promises';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { LEVEL_PRIORITY, assertK8sName, matchesQuery, parseLevel } from '@klv/core';
import type { LogLevel, QueryNode } from '@klv/core';
import type { HistoryStore } from './history-store';
import { isRecord } from './type-guards';
import type { HistoryLog, HistoryQueryResponse } from './history.types';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const MAX_FILTER_NAMES = 100;
const SCAN_BUDGET = 200_000;
const MAX_PAGE = 5000;
const MAX_QUERY_DEPTH = 64;
const MIN_FTS_TERM = 3;

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

const COLUMNS = `id, context, namespace, pod, container, ts_us, raw, is_json, timestamp, k8s_timestamp, level,
  message, service, env, version, trace_id, span_id, caller, error, stack_trace, extra`;

interface Position {
  tsUs: number;
  id: number;
}

interface Fragment {
  sql: string;
  params: SQLInputValue[];
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

function ftsFragment(value: string): Fragment | null {
  if (value.length < MIN_FTS_TERM || !PRINTABLE_ASCII.test(value)) return null;
  return {
    sql: 'l.id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)',
    params: [`"${value.replaceAll('"', '""')}"`],
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
    return { sql: `l.${column} = ? COLLATE NOCASE`, params: [node.value] };
  }
  return null;
}

function textFragment(node: Extract<QueryNode, { type: 'text' }>): Fragment | null {
  if (!node.wildcard) return ftsFragment(node.value);
  // Glob: cada tramo literal debe aparecer; se usa el más largo
  const longest = node.value.split('*').reduce((best, part) => (part.length > best.length ? part : best), '');
  return ftsFragment(longest);
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

function rowToLog(row: Record<string, SQLOutputValue>): HistoryLog {
  const text = (key: string): string | undefined => (typeof row[key] === 'string' ? row[key] as string : undefined);
  const timestamp = text('timestamp');
  const service = text('service');
  const env = text('env');
  const version = text('version');
  const traceId = text('trace_id');
  const spanId = text('span_id');
  const caller = text('caller');
  const error = text('error');
  const stackTrace = text('stack_trace');
  return {
    raw: row.raw as string,
    isJson: row.is_json === 1,
    ...(timestamp !== undefined && { timestamp }),
    k8sTimestamp: row.k8s_timestamp as string,
    level: row.level as LogLevel,
    message: row.message as string,
    ...(service !== undefined && { service }),
    ...(env !== undefined && { env }),
    ...(version !== undefined && { version }),
    ...(traceId !== undefined && { traceId }),
    ...(spanId !== undefined && { spanId }),
    ...(caller !== undefined && { caller }),
    ...(error !== undefined && { error }),
    ...(stackTrace !== undefined && { stackTrace }),
    podName: row.pod as string,
    extra: JSON.parse(row.extra as string) as Record<string, unknown>,
    context: row.context as string,
    namespace: row.namespace as string,
    container: row.container as string,
  };
}

function buildSql(request: ValidQuery): { sql: string; params: SQLInputValue[] } {
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];

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

  conditions.push('(l.ts_us, l.id) < (?, ?)');
  return {
    sql: `SELECT ${COLUMNS} FROM logs l WHERE ${conditions.join(' AND ')} ORDER BY l.ts_us DESC, l.id DESC LIMIT ?`,
    params,
  };
}

// Devuelve las `limit` coincidencias más recientes (orden ascendente) por páginas keyset, cediendo el event loop entre páginas
export async function queryHistory(store: HistoryStore, body: unknown): Promise<HistoryQueryResponse> {
  const request = validateRequest(body);
  const { sql, params } = buildSql(request);

  let position: Position = request.before ?? { tsUs: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
  const matches: HistoryLog[] = [];
  const positions: Position[] = [];
  let scanned = 0;
  let pageSize = Math.min(Math.max(request.limit, 100), MAX_PAGE);
  let nextCursor: string | null = null;
  let truncated = false;

  scan: while (true) {
    const size = Math.min(pageSize, SCAN_BUDGET - scanned);
    const rows = store.all(sql, [...params, position.tsUs, position.id, size]);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      scanned++;
      position = { tsUs: row.ts_us as number, id: row.id as number };
      const log = rowToLog(row);
      if (!matchesQuery(log, request.ast)) continue;

      matches.push(log);
      positions.push(position);
      if (matches.length === request.limit) {
        // Quedan filas por revisar salvo que este sea el final de los datos
        if (i < rows.length - 1 || rows.length === size) nextCursor = encodeCursor(position);
        break scan;
      }
    }

    if (rows.length < size) break;
    if (scanned >= SCAN_BUDGET) {
      truncated = true;
      nextCursor = encodeCursor(position);
      break;
    }
    pageSize = Math.min(pageSize * 2, MAX_PAGE);
    await yieldToEventLoop();
  }

  return { logs: matches.reverse(), nextCursor, scanned, truncated };
}
