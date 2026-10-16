import type { QueryableLog } from '@klv/query';
import { logTime } from './time';

export type BuiltinColumnId =
  | 'time'
  | 'level'
  | 'pod'
  | 'container'
  | 'namespace'
  | 'service'
  | 'env'
  | 'version'
  | 'trace'
  | 'caller'
  | 'message';

export type ColumnId = BuiltinColumnId | `@${string}`;

export const DEFAULT_COLUMNS: ColumnId[] = ['time', 'level', 'pod', 'message'];

export const BUILTIN_COLUMNS: ColumnId[] = [
  'time',
  'level',
  'pod',
  'container',
  'namespace',
  'service',
  'env',
  'version',
  'trace',
  'caller',
  'message',
];

const LABELS: Record<BuiltinColumnId, string> = {
  time: 'Time',
  level: 'Level',
  pod: 'Pod',
  container: 'Container',
  namespace: 'Namespace',
  service: 'Service',
  env: 'Env',
  version: 'Version',
  trace: 'Trace',
  caller: 'Caller',
  message: 'Message',
};

export function columnLabel(id: ColumnId): string {
  return id.startsWith('@') ? id : LABELS[id as BuiltinColumnId];
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Same resolution as the query language: flat key `extra["a.b"]` first, then the nested walk. */
function attributeValue(extra: Record<string, unknown>, path: string): unknown {
  const flat = extra[path];
  if (flat !== undefined && flat !== null) return flat;
  let current: unknown = extra;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function columnValue(log: QueryableLog, id: ColumnId): string {
  switch (id) {
    case 'time': {
      const time = logTime(log);
      return time === null ? '' : new Date(time).toISOString();
    }
    case 'level':
      return log.level;
    case 'pod':
      return log.podName ?? '';
    case 'container':
      return log.container ?? '';
    case 'namespace':
      return log.namespace ?? '';
    case 'service':
      return log.service ?? '';
    case 'env':
      return log.env ?? '';
    case 'version':
      return log.version ?? '';
    case 'trace':
      return log.traceId ?? '';
    case 'caller':
      return log.caller ?? '';
    case 'message':
      return log.message;
    default:
      return stringify(attributeValue(log.extra, id.slice(1)));
  }
}

function isColumnId(value: string): value is ColumnId {
  return BUILTIN_COLUMNS.includes(value as ColumnId) || /^@[^,\s]+$/.test(value);
}

/** Parses the `cols` URL parameter. Invalid entries are dropped, duplicates removed, `message` always kept. */
export function parseColumns(param: string | null): ColumnId[] {
  if (!param) return [...DEFAULT_COLUMNS];
  const columns: ColumnId[] = [];
  for (const part of param.split(',')) {
    const id = part.trim();
    if (isColumnId(id) && !columns.includes(id)) columns.push(id);
  }
  if (columns.length === 0) return [...DEFAULT_COLUMNS];
  if (!columns.includes('message')) columns.push('message');
  return columns;
}

export function serializeColumns(columns: ColumnId[]): string {
  return columns.join(',');
}
