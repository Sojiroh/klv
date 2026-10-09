import type { LogLevel, ParsedLog } from '../types';
import { logTime } from './time';

export interface HistogramBucket {
  start: number;
  total: number;
  counts: Record<LogLevel, number>;
}

export interface Histogram {
  from: number;
  to: number;
  bucketMs: number;
  buckets: HistogramBucket[];
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

function emptyCounts(): Record<LogLevel, number> {
  return { TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0, UNKNOWN: 0 };
}

/**
 * Counts logs per time bucket (and level) within `[from, to]`. Bucket size is the smallest step of
 * 1s…1d that yields at most `targetBuckets` buckets; buckets are aligned to multiples of that size.
 * Logs without a usable timestamp or outside the range are not counted.
 */
export function buildHistogram(
  logs: ParsedLog[],
  { from, to, targetBuckets = DEFAULT_TARGET_BUCKETS }: { from: number; to: number; targetBuckets?: number },
): Histogram {
  const span = Math.max(0, to - from);
  const wanted = span / Math.max(1, targetBuckets);
  const bucketMs =
    BUCKET_STEPS_MS.find((step) => step >= wanted) ?? BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];

  const firstStart = Math.floor(from / bucketMs) * bucketMs;
  const count = Math.max(1, Math.floor((to - firstStart) / bucketMs) + 1);
  const buckets: HistogramBucket[] = new Array(count);
  for (let i = 0; i < count; i++) {
    buckets[i] = { start: firstStart + i * bucketMs, total: 0, counts: emptyCounts() };
  }

  for (const log of logs) {
    const time = logTime(log);
    if (time === null || time < from || time > to) continue;
    const bucket = buckets[Math.floor((time - firstStart) / bucketMs)];
    bucket.total++;
    bucket.counts[log.level]++;
  }

  return { from, to, bucketMs, buckets };
}
