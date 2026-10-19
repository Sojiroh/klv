import type { ParsedLog } from '../types';
import { columnValue, type ColumnId } from './columns';
import { logTime } from './time';
import { LEVEL_ORDER } from '../utils/log-utils';

export const MAX_GROUPS = 8;
export const OTHER_GROUP = 'Other';
export const NONE_GROUP = '(none)';

export interface HistogramBucket {
  start: number;
  total: number;
  counts: Record<string, number>;
}

export interface Histogram {
  from: number;
  to: number;
  bucketMs: number;
  buckets: HistogramBucket[];
  groupBy: ColumnId;
  /** Groups in stacking order (level order, or top values by total with `Other` last). */
  groups: string[];
}

const BUCKET_STEPS_MS = [
  1_000,
  5_000,
  10_000,
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
];

const DEFAULT_TARGET_BUCKETS = 60;

/**
 * Counts logs per time bucket (and level) within `[from, to]`. Bucket size is the smallest step of
 * 1s…1d that yields at most `targetBuckets` buckets; buckets are aligned to multiples of that size.
 * Logs without a usable timestamp or outside the range are not counted.
 */
export function buildHistogram(
  logs: ParsedLog[],
  {
    from,
    to,
    targetBuckets = DEFAULT_TARGET_BUCKETS,
    groupBy = 'level',
  }: { from: number; to: number; targetBuckets?: number; groupBy?: ColumnId },
): Histogram {
  const span = Math.max(0, to - from);
  const wanted = span / Math.max(1, targetBuckets);
  const bucketMs =
    BUCKET_STEPS_MS.find((step) => step >= wanted) ?? BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];

  const firstStart = Math.floor(from / bucketMs) * bucketMs;
  const count = Math.max(1, Math.floor((to - firstStart) / bucketMs) + 1);
  const buckets: HistogramBucket[] = new Array(count);
  for (let i = 0; i < count; i++) {
    buckets[i] = { start: firstStart + i * bucketMs, total: 0, counts: {} };
  }

  const byLevel = groupBy === 'level' || groupBy === 'time' || groupBy === 'message';
  const totals = new Map<string, number>();
  for (const log of logs) {
    const time = logTime(log);
    if (time === null || time < from || time > to) continue;
    const bucket = buckets[Math.floor((time - firstStart) / bucketMs)];
    const group = byLevel ? log.level : columnValue(log, groupBy) || NONE_GROUP;
    bucket.total++;
    bucket.counts[group] = (bucket.counts[group] ?? 0) + 1;
    totals.set(group, (totals.get(group) ?? 0) + 1);
  }

  if (byLevel) return { from, to, bucketMs, buckets, groupBy: 'level', groups: LEVEL_ORDER };

  const ranked = [...totals.entries()].sort((x, y) => y[1] - x[1]).map(([value]) => value);
  const groups = ranked.slice(0, MAX_GROUPS);
  const rest = ranked.slice(MAX_GROUPS);
  if (rest.length > 0) {
    for (const bucket of buckets) {
      let other = 0;
      for (const value of rest) {
        other += bucket.counts[value] ?? 0;
        delete bucket.counts[value];
      }
      if (other > 0) bucket.counts[OTHER_GROUP] = other;
    }
    groups.push(OTHER_GROUP);
  }
  return { from, to, bucketMs, buckets, groupBy, groups };
}
