export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'UNKNOWN';

export interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  k8sTimestamp?: string;
  level: LogLevel;
  message: string;
  service?: string;
  env?: string;
  version?: string;
  traceId?: string;
  spanId?: string;
  caller?: string;
  error?: string;
  stackTrace?: string;
  podName?: string;
  extra: Record<string, unknown>;
}

// Campos comunes en distintos formatos de log JSON
const LEVEL_FIELDS = ['level', 'severity', 'log.level', 'loglevel', 'lvl', 'log_level'];
const MESSAGE_FIELDS = ['message', 'msg', 'log', 'text', 'body'];
const TIMESTAMP_FIELDS = ['timestamp', 'time', 'ts', '@timestamp', 'datetime', 'date', 'logged_at'];
const SERVICE_FIELDS = ['service', 'dd.service', 'dd_service', 'service_name', 'app', 'application', 'logger', 'logger_name'];
const ENV_FIELDS = ['dd.env', 'dd_env', 'env'];
const VERSION_FIELDS = ['dd.version', 'dd_version', 'version'];
const TRACE_FIELDS = ['dd.trace_id', 'dd_trace_id', 'trace_id', 'traceId', 'trace-id', 'x-request-id', 'request_id', 'requestId', 'correlationId'];
const SPAN_FIELDS = ['dd.span_id', 'dd_span_id', 'span_id', 'spanId', 'span-id'];
const ERROR_FIELDS = ['error.message', 'error', 'err', 'exception', 'error_message'];
const STACK_FIELDS = ['error.stack', 'stack', 'stackTrace', 'stack_trace', 'error.stack_trace'];
const CALLER_FIELDS = ['caller', 'source', 'class', 'method', 'function'];

// Claves crudas (planas o rutas con puntos) de las que se lee cada campo de ParsedLog direccionable por la
// consulta, en orden de precedencia. `status` solo aporta el nivel cuando es un alias de texto (ver levelFromStatus).
export const PARSED_FIELD_KEYS: Record<'level' | 'message' | 'service' | 'env' | 'version' | 'traceId' | 'spanId' | 'caller' | 'error', readonly string[]> = {
  level: [...LEVEL_FIELDS, 'status'],
  message: MESSAGE_FIELDS,
  service: SERVICE_FIELDS,
  env: ENV_FIELDS,
  version: VERSION_FIELDS,
  traceId: TRACE_FIELDS,
  spanId: SPAN_FIELDS,
  caller: CALLER_FIELDS,
  error: ERROR_FIELDS,
};

// Tags de Datadog dentro del objeto anidado `dd`
const DD_TAGS = ['trace_id', 'span_id', 'service', 'env', 'version'];
// Campos "conocidos" que se extraen y no van en extra
const KNOWN_FIELDS = new Set([
  ...LEVEL_FIELDS, ...MESSAGE_FIELDS, ...TIMESTAMP_FIELDS,
  ...SERVICE_FIELDS, ...ENV_FIELDS, ...VERSION_FIELDS, ...TRACE_FIELDS, ...SPAN_FIELDS,
  ...ERROR_FIELDS, ...STACK_FIELDS, ...CALLER_FIELDS,
]);

// Alias de niveles (texto). Los niveles numéricos (pino/bunyan) se mapean aparte.
const LEVEL_MAP: Record<string, LogLevel> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  information: 'INFO',
  notice: 'INFO',
  warn: 'WARN',
  warning: 'WARN',
  error: 'ERROR',
  err: 'ERROR',
  fatal: 'FATAL',
  critical: 'FATAL',
  crit: 'FATAL',
  alert: 'FATAL',
  emergency: 'FATAL',
  emerg: 'FATAL',
  panic: 'FATAL',
};

// Primero la clave plana literal ("log.level"), luego el recorrido anidado. Null/undefined se ignoran.
function findValue(obj: Record<string, unknown>, candidates: string[]): unknown {
  for (const field of candidates) {
    const flat = obj[field];
    if (flat !== undefined && flat !== null) return flat;
    if (!field.includes('.')) continue;

    let current: unknown = obj;
    for (const part of field.split('.')) {
      if (current && typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        current = undefined;
        break;
      }
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

function findField(obj: Record<string, unknown>, candidates: string[]): string | undefined {
  const value = findValue(obj, candidates);
  if (value === undefined) return undefined;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function parseLevel(raw: unknown): LogLevel {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return /^\d+$/.test(text) ? parseLevel(Number(text)) : (LEVEL_MAP[text.toLowerCase()] ?? 'UNKNOWN');
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 'UNKNOWN';
  if (raw >= 60) return 'FATAL';
  if (raw >= 50) return 'ERROR';
  if (raw >= 40) return 'WARN';
  if (raw >= 30) return 'INFO';
  if (raw >= 20) return 'DEBUG';
  if (raw >= 10) return 'TRACE';
  return 'UNKNOWN';
}

// `status` (atributo reservado de Datadog) solo cuenta como nivel si es texto; numérico = código HTTP.
function levelFromStatus(record: Record<string, unknown>): LogLevel {
  const status = record.status;
  return typeof status === 'string' ? (LEVEL_MAP[status.trim().toLowerCase()] ?? 'UNKNOWN') : 'UNKNOWN';
}

function detectLevelFromText(text: string): LogLevel {
  const logfmt = text.match(/\b(?:level|lvl|severity)=["']?([A-Za-z]+|\d+)/i);
  if (logfmt) {
    const level = parseLevel(logfmt[1]);
    if (level !== 'UNKNOWN') return level;
  }

  const keyword = text.match(/\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|ALERT|EMERG|EMERGENCY|PANIC)\b/);
  if (keyword) return parseLevel(keyword[1]);

  if (/\b(?:error|exception)\b/i.test(text) || /[a-z](?:Exception|Error)\b/.test(text)) return 'ERROR';
  if (/\bwarn(?:ing)?\b/i.test(text)) return 'WARN';
  return 'UNKNOWN';
}

// Epochs numéricos (s, ms, µs, ns) a ISO-8601 UTC; cualquier otro valor se conserva tal cual.
function normalizeTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const original = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const isEpoch = typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value));
  if (!isEpoch) return original;

  const n = typeof value === 'number' ? value : parseFloat(original);
  const ms = n < 1e11 ? n * 1e3 : n < 1e14 ? n : n < 1e17 ? n / 1e3 : n / 1e6;
  const date = new Date(Math.trunc(ms));
  return Number.isNaN(date.getTime()) ? original : date.toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Claves del objeto `error` que se hoistean a campos propios
const ERROR_OBJECT_HOISTED = ['message', 'stack', 'stack_trace'];

export function parseLogLine(line: string, podName?: string): ParsedLog {
  const trimmed = line.trim();

  // Intentar parsear como JSON
  // A veces los logs tienen un prefijo de timestamp de K8s antes del JSON
  let jsonStr = trimmed;
  let k8sTimestamp: string | undefined;

  // Formato: "2024-01-15T10:30:00.000Z {json...}"
  const k8sTsMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.+)$/);
  if (k8sTsMatch) {
    k8sTimestamp = k8sTsMatch[1];
    jsonStr = k8sTsMatch[2];
  }

  let record: Record<string, unknown> | undefined;
  try {
    const obj: unknown = JSON.parse(jsonStr);
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
      record = obj as Record<string, unknown>;
    }
  } catch {
    // No es JSON
  }

  if (!record) {
    // Texto plano
    return {
      raw: trimmed,
      isJson: false,
      timestamp: k8sTimestamp,
      ...(k8sTimestamp !== undefined && { k8sTimestamp }),
      level: detectLevelFromText(trimmed),
      message: trimmed,
      podName,
      extra: {},
    };
  }

  const timestamp = normalizeTimestamp(findValue(record, TIMESTAMP_FIELDS)) ?? k8sTimestamp;
  const message = findField(record, MESSAGE_FIELDS) ?? '';
  const fieldLevel = parseLevel(findValue(record, LEVEL_FIELDS));
  const statusLevel = fieldLevel === 'UNKNOWN' ? levelFromStatus(record) : 'UNKNOWN';
  const level = fieldLevel !== 'UNKNOWN' ? fieldLevel : statusLevel !== 'UNKNOWN' ? statusLevel : detectLevelFromText(message);

  // Un `error` objeto (estándar Datadog) nunca se convierte a texto: se hoistean message/stack y el resto queda en extra
  const errorObj = isPlainObject(record.error) ? record.error : undefined;

  // Extraer campos extra (todo lo que no es un campo conocido); status solo se excluye si aportó el nivel
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'status' && statusLevel !== 'UNKNOWN') continue;
    if (key === 'error' && errorObj) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(errorObj)) {
        if (!ERROR_OBJECT_HOISTED.includes(k)) rest[k] = v;
      }
      if (Object.keys(rest).length > 0) extra.error = rest;
      continue;
    }
    if (!KNOWN_FIELDS.has(key) && value !== undefined && value !== null) {
      extra[key] = value;
    }
  }

  // Los tags dd.* ya se hoistearon a campos propios: se quitan del objeto anidado `dd`
  const dd = extra.dd;
  if (typeof dd === 'object' && dd !== null && !Array.isArray(dd)) {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dd)) {
      if (!DD_TAGS.includes(key)) rest[key] = value;
    }
    if (Object.keys(rest).length === 0) delete extra.dd;
    else extra.dd = rest;
  }

  return {
    raw: trimmed,
    isJson: true,
    timestamp,
    ...(k8sTimestamp !== undefined && { k8sTimestamp }),
    level,
    message,
    service: findField(record, SERVICE_FIELDS),
    env: findField(record, ENV_FIELDS),
    version: findField(record, VERSION_FIELDS),
    traceId: findField(record, TRACE_FIELDS),
    spanId: findField(record, SPAN_FIELDS),
    caller: findField(record, CALLER_FIELDS),
    error: findField(record, errorObj ? ERROR_FIELDS.filter((f) => f !== 'error') : ERROR_FIELDS),
    stackTrace: findField(record, STACK_FIELDS),
    podName,
    extra,
  };
}

// Orden cronológico de logs agregados: clave = k8sTimestamp ?? timestamp; las claves no parseables van al final.
export function compareLogsByTime(a: ParsedLog, b: ParsedLog): number {
  const keyA = a.k8sTimestamp ?? a.timestamp ?? '';
  const keyB = b.k8sTimestamp ?? b.timestamp ?? '';
  const timeA = Date.parse(keyA);
  const timeB = Date.parse(keyB);
  const validA = !Number.isNaN(timeA);
  const validB = !Number.isNaN(timeB);

  if (validA && validB && timeA !== timeB) return timeA < timeB ? -1 : 1;
  if (validA !== validB) return validA ? -1 : 1;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

export function matchesFilter(log: ParsedLog, filter: LogFilter): boolean {
  if (filter.level && log.level !== filter.level) return false;
  if (filter.minLevel && LEVEL_PRIORITY[log.level] < LEVEL_PRIORITY[filter.minLevel]) return false;
  if (filter.search) {
    const term = filter.search.toLowerCase();
    const searchable = `${log.message} ${log.error ?? ''} ${log.service ?? ''} ${JSON.stringify(log.extra)}`.toLowerCase();
    if (!searchable.includes(term)) return false;
  }
  if (filter.traceId && log.traceId !== filter.traceId) return false;
  if (filter.service && log.service !== filter.service) return false;
  if (filter.excludePatterns) {
    for (const pattern of filter.excludePatterns) {
      if (log.message.includes(pattern)) return false;
    }
  }
  return true;
}

export interface LogFilter {
  level?: LogLevel;
  minLevel?: LogLevel;
  search?: string;
  traceId?: string;
  service?: string;
  excludePatterns?: string[];
}

export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
  UNKNOWN: -1,
};
