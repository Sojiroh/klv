export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'UNKNOWN';

export interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  level: LogLevel;
  message: string;
  service?: string;
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
const SERVICE_FIELDS = ['service', 'service_name', 'app', 'application', 'logger', 'logger_name'];
const TRACE_FIELDS = ['trace_id', 'traceId', 'trace-id', 'x-request-id', 'request_id', 'requestId', 'correlationId'];
const SPAN_FIELDS = ['span_id', 'spanId', 'span-id'];
const ERROR_FIELDS = ['error', 'err', 'exception', 'error_message'];
const STACK_FIELDS = ['stack', 'stackTrace', 'stack_trace', 'error.stack_trace'];
const CALLER_FIELDS = ['caller', 'source', 'class', 'method', 'function'];

// Campos "conocidos" que se extraen y no van en extra
const KNOWN_FIELDS = new Set([
  ...LEVEL_FIELDS, ...MESSAGE_FIELDS, ...TIMESTAMP_FIELDS,
  ...SERVICE_FIELDS, ...TRACE_FIELDS, ...SPAN_FIELDS,
  ...ERROR_FIELDS, ...STACK_FIELDS, ...CALLER_FIELDS,
]);

const LEVEL_MAP: Record<string, LogLevel> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  information: 'INFO',
  warn: 'WARN',
  warning: 'WARN',
  error: 'ERROR',
  err: 'ERROR',
  fatal: 'FATAL',
  critical: 'FATAL',
  panic: 'FATAL',
};

function findField(obj: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const field of candidates) {
    if (field.includes('.')) {
      const parts = field.split('.');
      let current: unknown = obj;
      for (const part of parts) {
        if (current && typeof current === 'object') {
          current = (current as Record<string, unknown>)[part];
        } else {
          current = undefined;
          break;
        }
      }
      if (current !== undefined) return typeof current === 'object' ? JSON.stringify(current) : String(current);
    } else if (obj[field] !== undefined && obj[field] !== null) {
      const val = obj[field];
      return typeof val === 'object' ? JSON.stringify(val) : String(val);
    }
  }
  return undefined;
}

function parseLevel(raw?: string): LogLevel {
  if (!raw) return 'UNKNOWN';
  return LEVEL_MAP[raw.toLowerCase()] ?? 'UNKNOWN';
}

function detectLevelFromMessage(message: string): LogLevel {
  const upper = message.toUpperCase();
  if (upper.includes('ERROR') || upper.includes('EXCEPTION')) return 'ERROR';
  if (upper.includes('WARN')) return 'WARN';
  if (upper.includes('DEBUG')) return 'DEBUG';
  return 'UNKNOWN';
}

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

  try {
    const obj = JSON.parse(jsonStr);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error('Not a JSON object');
    }

    const record = obj as Record<string, unknown>;
    const timestamp = findField(record, TIMESTAMP_FIELDS) ?? k8sTimestamp;
    const levelRaw = findField(record, LEVEL_FIELDS);
    const message = findField(record, MESSAGE_FIELDS) ?? '';
    const level = parseLevel(levelRaw) !== 'UNKNOWN'
      ? parseLevel(levelRaw)
      : detectLevelFromMessage(message);

    // Extraer campos extra (todo lo que no es un campo conocido)
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!KNOWN_FIELDS.has(key) && value !== undefined && value !== null) {
        extra[key] = value;
      }
    }

    return {
      raw: trimmed,
      isJson: true,
      timestamp,
      level,
      message,
      service: findField(record, SERVICE_FIELDS),
      traceId: findField(record, TRACE_FIELDS),
      spanId: findField(record, SPAN_FIELDS),
      caller: findField(record, CALLER_FIELDS),
      error: findField(record, ERROR_FIELDS),
      stackTrace: findField(record, STACK_FIELDS),
      podName,
      extra,
    };
  } catch {
    // No es JSON, tratar como texto plano
    return {
      raw: trimmed,
      isJson: false,
      timestamp: k8sTimestamp,
      level: detectLevelFromMessage(trimmed),
      message: trimmed,
      podName,
      extra: {},
    };
  }
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

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
  UNKNOWN: -1,
};
