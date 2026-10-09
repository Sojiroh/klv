import type { ParsedLog } from '../types';

export interface TimeRangePreset {
  id: '15m' | '1h' | '4h' | '24h' | '7d' | '30d';
  label: string;
  ms: number;
}

export const TIME_RANGES: TimeRangePreset[] = [
  { id: '15m', label: 'Past 15 minutes', ms: 15 * 60_000 },
  { id: '1h', label: 'Past 1 hour', ms: 60 * 60_000 },
  { id: '4h', label: 'Past 4 hours', ms: 4 * 60 * 60_000 },
  { id: '24h', label: 'Past 24 hours', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'Past 7 days', ms: 7 * 24 * 60 * 60_000 },
  { id: '30d', label: 'Past 30 days', ms: 30 * 24 * 60 * 60_000 },
];

/** `range: 'custom'` uses `from`/`to` (epoch ms); any other value is a TIME_RANGES id. */
export type TimeRangeState = { range: string; from?: number; to?: number };

/** Epoch milliseconds of the log (`k8sTimestamp ?? timestamp`), or null when absent or unparseable. */
export function logTime(log: ParsedLog): number | null {
  const raw = log.k8sTimestamp ?? log.timestamp;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

export function resolveRange(state: TimeRangeState, now: number = Date.now()): { from: number; to: number } {
  if (state.range === 'custom') {
    return { from: state.from ?? now - TIME_RANGES[1].ms, to: state.to ?? now };
  }
  const preset = TIME_RANGES.find((r) => r.id === state.range) ?? TIME_RANGES[1];
  return { from: now - preset.ms, to: now };
}

export function sinceSeconds(from: number, now: number = Date.now()): number {
  return Math.max(1, Math.ceil((now - from) / 1000));
}
