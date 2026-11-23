import { matchesQuery, type QueryNode } from '../../lib/query';
import { cachedTime } from '../../lib/time';
import { patternId } from '../../lib/patterns';
import type { ParsedLog } from '../../types';

// Log objects are immutable once loaded; caching per object keeps re-filtering a growing live buffer cheap.
const matches = new WeakMap<QueryNode, WeakMap<ParsedLog, boolean>>();

/** Logs inside `[from, to)`; logs without a usable timestamp are kept. */
export function filterWindow(logs: ParsedLog[], from: number, to: number): ParsedLog[] {
  return logs.filter((log) => {
    const time = cachedTime(log);
    return time === null || (time >= from && time < to);
  });
}

export function filterQuery(logs: ParsedLog[], ast: QueryNode | null): ParsedLog[] {
  if (!ast) return logs;
  let cache = matches.get(ast);
  if (!cache) {
    cache = new WeakMap();
    matches.set(ast, cache);
  }
  const results = cache;
  return logs.filter((log) => {
    let hit = results.get(log);
    if (hit === undefined) {
      hit = matchesQuery(log, ast);
      results.set(log, hit);
    }
    return hit;
  });
}

export function filterPattern(logs: ParsedLog[], id: string | null): ParsedLog[] {
  if (!id) return logs;
  return logs.filter((log) => patternId(log) === id);
}
