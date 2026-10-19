import { quoteQueryValue } from '@klv/query';

export { parseQuery, matchesQuery, quoteQueryValue, rawFieldFilter } from '@klv/query';
export type {
  QueryField,
  QueryNode,
  QueryParseResult,
  QueryableLog,
  RawFieldFilter,
  ReservedField,
} from '@klv/query';

export function fieldClause(field: string, value: string): string {
  return `${field}:${quoteQueryValue(value)}`;
}

/** Splits a query into top-level whitespace-separated tokens (quotes and parentheses kept intact). */
function topLevelTokens(query: string): string[] {
  const tokens: string[] = [];
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
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Adds `clause` (or `-clause` when excluding) ANDed at the end of the query. If the same clause or its
 * negation is already a top-level term it is removed first, so applying the same mode twice toggles it off
 * and applying the opposite mode swaps it.
 */
export function toggleClause(query: string, clause: string, mode: 'include' | 'exclude'): string {
  let tokens = topLevelTokens(query);
  if (tokens.includes('OR')) tokens = [`(${query.trim()})`];

  const removed = new Set<number>();
  let sameMode = false;
  tokens.forEach((token, i) => {
    let negated: boolean;
    let start = i;
    if (token === clause) {
      negated = i > 0 && tokens[i - 1] === 'NOT';
      if (negated) start = i - 1;
    } else if (token === `-${clause}`) {
      negated = true;
    } else {
      return;
    }
    if (negated === (mode === 'exclude')) sameMode = true;
    for (let k = start; k <= i; k++) removed.add(k);
    if (start > 0 && tokens[start - 1] === 'AND') removed.add(start - 1);
    else if (tokens[i + 1] === 'AND') removed.add(i + 1);
  });

  const kept = tokens.filter((_, i) => !removed.has(i));
  if (!sameMode) kept.push(mode === 'exclude' ? `-${clause}` : clause);
  return kept.join(' ');
}
