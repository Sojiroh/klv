import type { ColumnId } from '../../lib/columns';

export type ClauseState = 'include' | 'exclude' | null;

/** Top-level whitespace-separated terms; quotes, parentheses and `[A TO B]` ranges stay intact. */
function topLevelTerms(query: string): string[] {
  const terms: string[] = [];
  let current = '';
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '\\' && i + 1 < query.length) {
      current += ch + query[++i];
      continue;
    }
    if (inQuote) {
      if (ch === '"') inQuote = false;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /\s/.test(ch)) {
      if (current) terms.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) terms.push(current);
  return terms;
}

/** Whether `clause` (e.g. `service:api`) is a top-level included or excluded term of `query`. */
export function clauseState(query: string, clause: string): ClauseState {
  const terms = topLevelTerms(query);
  for (let i = 0; i < terms.length; i++) {
    if (terms[i] === `-${clause}`) return 'exclude';
    if (terms[i] === clause) return i > 0 && terms[i - 1] === 'NOT' ? 'exclude' : 'include';
  }
  return null;
}

export interface AttributeEntry {
  /** `@dot.path` as used in queries and columns. */
  field: string;
  display: string;
  /** Scalar short enough to be used as a filter value. */
  filterable: boolean;
}

const MAX_DEPTH = 3;
const MAX_FILTER_VALUE_LENGTH = 200;

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Flattens `extra` into `@path` entries (depth <= 3, scalar array elements listed individually). */
export function flattenExtra(extra: Record<string, unknown>): AttributeEntry[] {
  const entries: AttributeEntry[] = [];

  const visit = (value: unknown, path: string, depth: number) => {
    if (value === null || value === undefined) return;
    const text = scalar(value);
    if (text !== null) {
      entries.push({ field: `@${path}`, display: text, filterable: text.length > 0 && text.length <= MAX_FILTER_VALUE_LENGTH });
      return;
    }
    if (Array.isArray(value)) {
      if (value.every((item) => item === null || scalar(item) !== null)) {
        for (const item of value) visit(item, path, depth);
      } else {
        entries.push({ field: `@${path}`, display: JSON.stringify(value), filterable: false });
      }
      return;
    }
    if (typeof value === 'object') {
      if (depth >= MAX_DEPTH) {
        entries.push({ field: `@${path}`, display: JSON.stringify(value), filterable: false });
        return;
      }
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, depth + 1);
    }
  };

  for (const [key, value] of Object.entries(extra)) visit(value, key, 1);
  return entries;
}

/** Inserts before `message` so the message column stays last-ish and wide. */
export function withColumn(columns: ColumnId[], id: ColumnId): ColumnId[] {
  if (columns.includes(id)) return columns;
  const at = columns.indexOf('message');
  return at === -1 ? [...columns, id] : [...columns.slice(0, at), id, ...columns.slice(at)];
}

export function withoutColumn(columns: ColumnId[], id: ColumnId): ColumnId[] {
  return id === 'message' ? columns : columns.filter((c) => c !== id);
}
