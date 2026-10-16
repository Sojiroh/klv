import type { QueryableLog } from '@klv/query';

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

interface FacetOptions {
  maxAttributes?: number;
  maxValues?: number;
}

interface Tally {
  logs: number;
  values: Map<string, number>;
}

const MAX_DEPTH = 3;
const MAX_VALUE_LENGTH = 200;
/** Guards against unbounded memory on high-cardinality / dynamic-key attributes. */
const MAX_TRACKED_PATHS = 500;
const MAX_TRACKED_VALUES = 10_000;

const FIXED_FACETS: { field: string; label: string; read: (log: QueryableLog) => string | undefined }[] = [
  { field: 'level', label: 'Level', read: (log) => log.level },
  { field: 'pod', label: 'Pod', read: (log) => log.podName },
  { field: 'container', label: 'Container', read: (log) => log.container },
  { field: 'namespace', label: 'Namespace', read: (log) => log.namespace },
  { field: 'service', label: 'Service', read: (log) => log.service },
  { field: 'env', label: 'Env', read: (log) => log.env },
  { field: 'version', label: 'Version', read: (log) => log.version },
];

function bump(tally: Tally, value: string): void {
  const current = tally.values.get(value);
  if (current !== undefined) tally.values.set(value, current + 1);
  else if (tally.values.size < MAX_TRACKED_VALUES) tally.values.set(value, 1);
}

function scalarValue(value: unknown): string | null {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else return null;
  return text === '' || text.length > MAX_VALUE_LENGTH ? null : text;
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
      if (text === null) continue;
      const list = out.get(path);
      if (!list) out.set(path, [text]);
      else if (!list.includes(text)) list.push(text);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return;
    for (const [key, child] of Object.entries(value)) {
      flatten(child, path ? `${path}.${key}` : key, depth + 1, out);
    }
    return;
  }
  const text = scalarValue(value);
  if (text === null) return;
  const list = out.get(path);
  if (!list) out.set(path, [text]);
  else if (!list.includes(text)) list.push(text);
}

function sortedValues(tally: Tally, maxValues: number): FacetValue[] {
  return [...tally.values]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, maxValues);
}

/** Single pass over the logs; fixed facets first, then `@attribute` facets ordered by log coverage. */
export function computeFacets(logs: QueryableLog[], options: FacetOptions = {}): Facet[] {
  const { maxAttributes = 20, maxValues = 10 } = options;

  const fixed = FIXED_FACETS.map(() => ({ logs: 0, values: new Map<string, number>() }));
  const attrs = new Map<string, Tally>();
  const perLog = new Map<string, string[]>();

  for (const log of logs) {
    for (let i = 0; i < FIXED_FACETS.length; i++) {
      const value = FIXED_FACETS[i].read(log);
      if (value) {
        fixed[i].logs++;
        bump(fixed[i], value);
      }
    }

    perLog.clear();
    for (const [key, value] of Object.entries(log.extra)) {
      flatten(value, key, 1, perLog);
    }
    for (const [path, values] of perLog) {
      let tally = attrs.get(path);
      if (!tally) {
        if (attrs.size >= MAX_TRACKED_PATHS) continue;
        tally = { logs: 0, values: new Map() };
        attrs.set(path, tally);
      }
      tally.logs++;
      for (const value of values) bump(tally, value);
    }
  }

  const facets: Facet[] = [];
  FIXED_FACETS.forEach(({ field, label }, i) => {
    const tally = fixed[i];
    if (tally.logs === 0) return;
    if (field === 'namespace' && tally.values.size <= 1) return;
    facets.push({ field, label, total: tally.logs, values: sortedValues(tally, maxValues) });
  });

  const attributeFacets = [...attrs]
    .sort((a, b) => b[1].logs - a[1].logs || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxAttributes)
    .map(([path, tally]) => ({
      field: `@${path}`,
      label: `@${path}`,
      total: tally.logs,
      values: sortedValues(tally, maxValues),
    }));

  return facets.concat(attributeFacets);
}
