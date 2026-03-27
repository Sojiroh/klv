export const levelConfig: Record<string, { color: string; bg: string; icon: string }> = {
  TRACE: { color: 'text-zinc-500', bg: 'bg-zinc-500/10', icon: '·' },
  DEBUG: { color: 'text-sky-400', bg: 'bg-sky-400/10', icon: '●' },
  INFO: { color: 'text-emerald-400', bg: 'bg-emerald-400/10', icon: '●' },
  WARN: { color: 'text-amber-400', bg: 'bg-amber-400/10', icon: '▲' },
  ERROR: { color: 'text-red-400', bg: 'bg-red-400/10', icon: '✕' },
  FATAL: { color: 'text-red-500 font-semibold', bg: 'bg-red-500/15', icon: '☠' },
  UNKNOWN: { color: 'text-zinc-400', bg: 'bg-zinc-400/10', icon: '?' },
};

export const levelColors: Record<string, string> = {
  TRACE: 'text-zinc-500',
  DEBUG: 'text-sky-400',
  INFO: 'text-emerald-400',
  WARN: 'text-amber-400',
  ERROR: 'text-red-400',
  FATAL: 'text-red-500',
  UNKNOWN: 'text-zinc-400',
};

export const levelBg: Record<string, string> = {
  TRACE: 'bg-zinc-500/10',
  DEBUG: 'bg-sky-400/10',
  INFO: 'bg-emerald-400/10',
  WARN: 'bg-amber-400/10',
  ERROR: 'bg-red-400/10',
  FATAL: 'bg-red-500/15',
  UNKNOWN: 'bg-zinc-400/10',
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

export function formatTime(ts?: string): string {
  if (!ts) return '--:--:--';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return ts.substring(0, 12);
  }
}

export function formatTimestamp(ts?: string): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('en-US', { hour12: false });
  } catch {
    return ts;
  }
}
