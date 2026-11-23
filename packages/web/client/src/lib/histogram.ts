import type { ParsedLog } from '../types';
import { columnValue, type ColumnId } from './columns';
import { JOB_CHUNK, type Job } from './job';
import { cachedTime } from './time';
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

interface TimeScan {
  /** Timestamp of every log, NaN where it has none. */
  times: Float64Array;
  /** Earliest / latest timestamp, or null when no log has one. */
  span: { from: number; to: number } | null;
}

function* scanTimes(logs: ParsedLog[]): Job<TimeScan> {
  const times = new Float64Array(logs.length);
  let from = Infinity;
  let to = -Infinity;
  for (let i = 0; i < logs.length; i++) {
    if ((i & (JOB_CHUNK - 1)) === JOB_CHUNK - 1) yield;
    const time = cachedTime(logs[i]);
    if (time === null) {
      times[i] = NaN;
      continue;
    }
    times[i] = time;
    if (time < from) from = time;
    if (time > to) to = time;
  }
  return { times, span: from === Infinity ? null : { from, to } };
}

/**
 * Counts logs per time bucket (and level) within `[from, to]`. Bucket size is the smallest step of
 * 1s…1d that yields at most `targetBuckets` buckets; buckets are aligned to multiples of that size.
 * Logs without a usable timestamp or outside the range are not counted.
 * `range` fixes the interval; without one it spans the logs themselves (at least one second).
 */
export function* histogramJob(
  logs: ParsedLog[],
  {
    range,
    targetBuckets = DEFAULT_TARGET_BUCKETS,
    groupBy = 'level',
  }: { range: { from: number; to: number } | null; targetBuckets?: number; groupBy?: ColumnId },
): Job<Histogram> {
  // Without a fixed range the logs are scanned once for their span; that pass also keeps the timestamps for counting
  const scan = range ? null : yield* scanTimes(logs);
  const span = range ?? scan?.span ?? null;
  const { from, to } = span ? { from: span.from, to: Math.max(span.to, span.from + 1000) } : { from: 0, to: 1000 };

  const rangeMs = Math.max(0, to - from);
  const wanted = rangeMs / Math.max(1, targetBuckets);
  const bucketMs =
    BUCKET_STEPS_MS.find((step) => step >= wanted) ?? BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];

  const firstStart = Math.floor(from / bucketMs) * bucketMs;
  const count = Math.max(1, Math.floor((to - firstStart) / bucketMs) + 1);
  const buckets: HistogramBucket[] = new Array(count);
  for (let i = 0; i < count; i++) {
    // No prototype: group names come from log data (`__proto__`, `constructor`, …) and must stay plain keys.
    buckets[i] = { start: firstStart + i * bucketMs, total: 0, counts: Object.create(null) as Record<string, number> };
  }

  const byLevel = groupBy === 'level' || groupBy === 'time' || groupBy === 'message';
  const totals = new Map<string, number>();
  for (let i = 0; i < logs.length; i++) {
    if ((i & (JOB_CHUNK - 1)) === JOB_CHUNK - 1) yield;
    const log = logs[i];
    const time = scan ? (Number.isNaN(scan.times[i]) ? null : scan.times[i]) : cachedTime(log);
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
