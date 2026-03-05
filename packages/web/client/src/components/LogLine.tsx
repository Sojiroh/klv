interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  level: string;
  message: string;
  service?: string;
  podName?: string;
  error?: string;
  stackTrace?: string;
  extra: Record<string, unknown>;
}

const levelColors: Record<string, string> = {
  TRACE: 'text-gray-500',
  DEBUG: 'text-cyan-400',
  INFO: 'text-green-400',
  WARN: 'text-yellow-400',
  ERROR: 'text-red-400',
  FATAL: 'text-red-600 font-bold',
  UNKNOWN: 'text-gray-400',
};

const levelIcons: Record<string, string> = {
  TRACE: '\u00B7', DEBUG: '\u25CB', INFO: '\u25CF',
  WARN: '\u25B2', ERROR: '\u2716', FATAL: '\u2620', UNKNOWN: '?',
};

function formatTime(ts?: string): string {
  if (!ts) return '--:--:--';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return ts.substring(0, 12);
  }
}

export default function LogLine({ log, showRaw }: { log: ParsedLog; showRaw: boolean }) {
  if (showRaw) {
    return (
      <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap py-0.5">
        {log.isJson ? JSON.stringify(JSON.parse(log.raw), null, 2) : log.raw}
      </pre>
    );
  }

  return (
    <div className="font-mono text-xs py-0.5 flex gap-2 hover:bg-gray-900/30">
      <span className="text-gray-500 shrink-0">{formatTime(log.timestamp)}</span>
      <span className={`shrink-0 w-14 ${levelColors[log.level] ?? 'text-gray-400'}`}>
        {levelIcons[log.level] ?? '?'} {log.level.padEnd(5)}
      </span>
      {log.service && <span className="text-blue-400 shrink-0">({log.service})</span>}
      <span className={log.level === 'ERROR' || log.level === 'FATAL' ? 'text-red-300' : 'text-gray-200'}>
        {log.message}
      </span>
    </div>
  );
}
