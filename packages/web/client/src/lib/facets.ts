import type { QueryableLog } from '@klv/query';
import { JOB_CHUNK, type Job } from './job';

export interface FacetValue {
  value: string;
  count: number;
}

export interface Facet {
  /** Query field name: `level`, `pod`, … or `@attribute.path`. */
  field: string;
  label: string;
  /** Number of logs that have at least one value for the field. */
  total: number;
  values: FacetValue[];
}

export interface FacetOptions {
  maxAttributes?: number;
  maxValues?: number;
}

interface Tally {
  logs: number;
  values: Map<string, FacetValue>;
}

const MAX_DEPTH = 3;
const MAX_VALUE_LENGTH = 200;
/** Guards against unbounded memory on high-cardinality / dynamic-key attributes. */
const MAX_TRACKED_PATHS = 500;
const MAX_TRACKED_VALUES = 10_000;
/** Bound on the interned attribute paths: dynamic keys must not grow the table forever. */
const MAX_INTERNED_PATHS = 20_000;

const FIXED_FACETS: { field: string; label: string; read: (log: QueryableLog) => string | undefined }[] = [
  { field: 'level', label: 'Level', read: (log) => log.level },
  { field: 'pod', label: 'Pod', read: (log) => log.podName },
  { field: 'container', label: 'Container', read: (log) => log.container },
  { field: 'namespace', label: 'Namespace', read: (log) => log.namespace },
  { field: 'service', label: 'Service', read: (log) => log.service },
  { field: 'env', label: 'Env', read: (log) => log.env },
  { field: 'version', label: 'Version', read: (log) => log.version },
];

/**
 * Attribute paths and values of one log as a flat list `[path, n, value₁…valueₙ, path, n, …]`, in first-seen
 * path order. Flat and with interned path strings so that caching it for every buffered log stays small.
 */
type LogAttributes = readonly (string | number)[];

const NO_ATTRIBUTES: LogAttributes = [];

// Log objects are immutable once loaded: the flattened attributes are computed once per object.
const attributeCache = new WeakMap<QueryableLog, LogAttributes>();

// Attribute paths repeat on every log; Maps (not objects) keep keys such as `__proto__` inert.
const internedPaths = new Map<string, Map<string, string>>();
let internedCount = 0;

function joinPath(parent: string, key: string): string {
  let children = internedPaths.get(parent);
  if (children === undefined) {
    if (internedCount >= MAX_INTERNED_PATHS) return parent ? `${parent}.${key}` : key;
    children = new Map();
    internedPaths.set(parent, children);
  }
  let path = children.get(key);
  if (path === undefined) {
    path = parent ? `${parent}.${key}` : key;
    if (internedCount < MAX_INTERNED_PATHS) {
      children.set(key, path);
      internedCount++;
    }
  }
  return path;
}

function bump(tally: Tally, value: string): void {
  const current = tally.values.get(value);
  if (current !== undefined) current.count++;
  else if (tally.values.size < MAX_TRACKED_VALUES) tally.values.set(value, { value, count: 1 });
}

function scalarValue(value: unknown): string | null {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else return null;
  return text === '' || text.length > MAX_VALUE_LENGTH ? null : text;
}

function addValue(out: Map<string, string[]>, path: string, text: string): void {
  const list = out.get(path);
  if (!list) out.set(path, [text]);
  else if (!list.includes(text)) list.push(text);
}

/** Collects `path → distinct scalar values` for one log (depth <= MAX_DEPTH path segments). */
function flatten(
  value: unknown,
  path: string,
  depth: number,
  out: Map<string, string[]>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = scalarValue(item);
      if (text !== null) addValue(out, path, text);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return;
    // Own enumerable keys only: an attribute named `__proto__` is plain data here, never a prototype.
    for (const [key, child] of Object.entries(value)) {
      flatten(child, joinPath(path, key), depth + 1, out);
    }
    return;
  }
  const text = scalarValue(value);
  if (text !== null) addValue(out, path, text);
}

function logAttributes(log: QueryableLog): LogAttributes {
  let cached = attributeCache.get(log);
  if (cached === undefined) {
    const perLog = new Map<string, string[]>();
    for (const [key, value] of Object.entries(log.extra)) {
      flatten(value, joinPath('', key), 1, perLog);
    }
    if (perLog.size === 0) {
      cached = NO_ATTRIBUTES;
    } else {
      const flat: (string | number)[] = [];
      for (const [path, values] of perLog) {
        flat.push(path, values.length);
        for (const value of values) flat.push(value);
      }
      cached = flat;
    }
    attributeCache.set(log, cached);
  }
  return cached;
}

function rank(a: FacetValue, b: FacetValue): number {
  return b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
}

/** The `max` best values (most frequent first, ties alphabetical): a selection, not a sort of up to MAX_TRACKED_VALUES entries. */
function topValues(tally: Tally, max: number): FacetValue[] {
  const top: FacetValue[] = [];
  if (max <= 0) return top;
  for (const entry of tally.values.values()) {
    if (top.length === max && rank(entry, top[max - 1]) >= 0) continue;
    let at = top.length === max ? max - 1 : top.length;
    while (at > 0 && rank(entry, top[at - 1]) < 0) {
      top[at] = top[at - 1];
      at--;
    }
    top[at] = entry;
  }
  return top;
}

/** Single pass over the logs; fixed facets first, then `@attribute` facets ordered by log coverage. */
export function* facetsJob(logs: QueryableLog[], options: FacetOptions = {}): Job<Facet[]> {
  const { maxAttributes = 20, maxValues = 10 } = options;

  const fixed: Tally[] = FIXED_FACETS.map(() => ({ logs: 0, values: new Map() }));
  const attrs = new Map<string, Tally>();

  for (let i = 0; i < logs.length; i++) {
    if ((i & (JOB_CHUNK - 1)) === JOB_CHUNK - 1) yield;
    const log = logs[i];

    for (let f = 0; f < FIXED_FACETS.length; f++) {
      const value = FIXED_FACETS[f].read(log);
      if (value) {
        fixed[f].logs++;
        bump(fixed[f], value);
      }
    }

    const flat = logAttributes(log);
    for (let at = 0; at < flat.length; ) {
      const path = flat[at] as string;
      const count = flat[at + 1] as number;
      let tally = attrs.get(path);
      if (!tally && attrs.size < MAX_TRACKED_PATHS) {
        tally = { logs: 0, values: new Map() };
        attrs.set(path, tally);
      }
      if (tally) {
        tally.logs++;
        for (let v = 0; v < count; v++) bump(tally, flat[at + 2 + v] as string);
      }
      at += 2 + count;
    }
  }

  const facets: Facet[] = [];
  for (let i = 0; i < FIXED_FACETS.length; i++) {
    const { field, label } = FIXED_FACETS[i];
    const tally = fixed[i];
    if (tally.logs === 0) continue;
    if (field === 'namespace' && tally.values.size <= 1) continue;
    facets.push({ field, label, total: tally.logs, values: topValues(tally, maxValues) });
    yield;
  }

  const byCoverage = [...attrs].sort((a, b) => b[1].logs - a[1].logs || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [path, tally] of byCoverage.slice(0, maxAttributes)) {
    facets.push({ field: `@${path}`, label: `@${path}`, total: tally.logs, values: topValues(tally, maxValues) });
    yield;
  }
  return facets;
}
