import type { LogLevel } from '../types';

export const LEVEL_ORDER: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'UNKNOWN'];

export const levelConfig: Record<string, { color: string; bg: string; icon: string }> = {
  TRACE: { color: 'text-zinc-500', bg: 'bg-zinc-500/10', icon: '·' },
  DEBUG: { color: 'text-sky-400', bg: 'bg-sky-400/10', icon: '●' },
  INFO: { color: 'text-emerald-400', bg: 'bg-emerald-400/10', icon: '●' },
  WARN: { color: 'text-amber-400', bg: 'bg-amber-400/10', icon: '▲' },
  ERROR: { color: 'text-red-400', bg: 'bg-red-400/10', icon: '✕' },
  FATAL: { color: 'text-red-500 font-semibold', bg: 'bg-red-500/15', icon: '☠' },
  UNKNOWN: { color: 'text-zinc-400', bg: 'bg-zinc-400/10', icon: '?' },
};

export const statusStyles: Record<string, { dot: string; text: string }> = {
  Running: { dot: 'bg-emerald-400', text: 'text-emerald-400' },
  Pending: { dot: 'bg-amber-400', text: 'text-amber-400' },
  Succeeded: { dot: 'bg-sky-400', text: 'text-sky-400' },
  Failed: { dot: 'bg-red-400', text: 'text-red-400' },
  Unknown: { dot: 'bg-zinc-500', text: 'text-zinc-500' },
};

export function prettyRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    const match = raw.match(/^\S+\s+([\[{].*)$/s);
    if (match) {
      try {
        return JSON.stringify(JSON.parse(match[1]), null, 2);
      } catch {}
    }
    return raw;
  }
}

function parseDate(ts: string): Date | null {
  let d: Date;
  if (/^\d+(\.\d+)?$/.test(ts)) {
    const n = Number(ts);
    const ms = n < 1e11 ? n * 1000 : n < 1e14 ? n : n < 1e17 ? n / 1e3 : n / 1e6;
    d = new Date(Math.trunc(ms));
  } else {
    d = new Date(ts);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatTimestamp(ts?: string): string {
  if (!ts) return '--';
  const d = parseDate(ts);
  if (!d) return ts;
  return d.toLocaleString('en-US', { hour12: false });
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `HH:MM:SS.mmm` in local time, prefixed by `MM-DD` when `withDate`. */
export function formatMs(ms: number | null, withDate = false): string {
  if (ms === null) return '--:--:--';
  const d = new Date(ms);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  return withDate ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}` : clock;
}

/** Axis label: time-only for short spans, date + time otherwise. */
export function formatTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const date = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (spanMs <= 10 * 60_000) return `${hm}:${pad2(d.getSeconds())}`;
  if (spanMs <= 24 * 60 * 60_000) return hm;
  return `${date} ${hm}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
