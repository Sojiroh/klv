import { matchesQuery, type QueryNode } from '../../lib/query';
import { logTime } from '../../lib/time';
import { patternId } from '../../lib/patterns';
import type { ParsedLog } from '../../types';

// Log objects are immutable once loaded; caching per object keeps re-filtering a growing live buffer cheap.
const times = new WeakMap<ParsedLog, number | null>();
const matches = new WeakMap<QueryNode, WeakMap<ParsedLog, boolean>>();
const patternIds = new WeakMap<ParsedLog, string>();

export function cachedTime(log: ParsedLog): number | null {
  let time = times.get(log);
  if (time === undefined) {
    time = logTime(log);
    times.set(log, time);
  }
  return time;
}

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
  return logs.filter((log) => {
    let value = patternIds.get(log);
    if (value === undefined) {
      value = patternId(log);
      patternIds.set(log, value);
    }
    return value === id;
  });
}

/** Earliest / latest timestamp of the logs, or null when none has one. */
export function timeSpan(logs: ParsedLog[]): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const log of logs) {
    const time = cachedTime(log);
    if (time === null) continue;
    if (time < from) from = time;
    if (time > to) to = time;
  }
  return from === Infinity ? null : { from, to };
}
