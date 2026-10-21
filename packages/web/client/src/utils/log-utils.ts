import type { LogLevel } from '../types';
import type { RolloutPhase } from '../lib/rollout';

export const LEVEL_ORDER: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'UNKNOWN'];

// Colores de estado estilo Datadog sobre fondo claro: error rojo, warn ambar, info azul, debug morado
export const levelConfig: Record<string, { color: string; bg: string; icon: string }> = {
  TRACE: { color: 'text-slate-400', bg: 'bg-slate-100', icon: '·' },
  DEBUG: { color: 'text-violet-600', bg: 'bg-violet-50', icon: '●' },
  INFO: { color: 'text-blue-600', bg: 'bg-blue-50', icon: '●' },
  WARN: { color: 'text-amber-600', bg: 'bg-amber-50', icon: '▲' },
  ERROR: { color: 'text-red-600', bg: 'bg-red-50', icon: '✕' },
  FATAL: { color: 'text-red-700 font-semibold', bg: 'bg-red-100', icon: '☠' },
  UNKNOWN: { color: 'text-slate-500', bg: 'bg-slate-100', icon: '?' },
};

export const statusStyles: Record<string, { dot: string; text: string }> = {
  Running: { dot: 'bg-emerald-500', text: 'text-emerald-600' },
  Pending: { dot: 'bg-amber-500', text: 'text-amber-600' },
  Succeeded: { dot: 'bg-blue-500', text: 'text-blue-600' },
  Failed: { dot: 'bg-red-500', text: 'text-red-600' },
  Unknown: { dot: 'bg-slate-400', text: 'text-slate-500' },
};

export const rolloutStyles: Record<RolloutPhase, { dot: string; text: string; label: string }> = {
  ready: { dot: 'bg-emerald-500', text: 'text-emerald-600', label: 'Ready' },
  progressing: { dot: 'bg-blue-500 animate-pulse-dot', text: 'text-blue-600', label: 'Rolling out' },
  unavailable: { dot: 'bg-amber-500', text: 'text-amber-600', label: 'Unavailable' },
  failed: { dot: 'bg-red-500', text: 'text-red-600', label: 'Failed' },
  paused: { dot: 'bg-slate-400', text: 'text-slate-500', label: 'Paused' },
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
