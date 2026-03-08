import { useEffect } from 'react';

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
  FATAL: 'text-red-600',
  UNKNOWN: 'text-gray-400',
};

function prettyRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    const match = raw.match(/^\S+\s+([\[{].*)$/s);
    if (match) {
      try { return JSON.stringify(JSON.parse(match[1]), null, 2); } catch { /* fall through */ }
    }
    return raw;
  }
}

function formatTimestamp(ts?: string): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('en-US', { hour12: false });
  } catch {
    return ts;
  }
}

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex gap-2 py-1">
      <span className="text-gray-500 shrink-0 w-24">{label}</span>
      <span className={color ?? 'text-gray-200'}>{value}</span>
    </div>
  );
}

export default function LogDetailPanel({ log, onClose }: { log: ParsedLog | null; onClose: () => void }) {
  const open = log !== null;

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-1/2 max-w-2xl bg-gray-900 border-l border-gray-700 z-50 transform transition-transform duration-200 ease-out ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {log && (
          <div className="h-full flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <div className="flex items-center gap-3">
                <span className={`text-sm font-semibold ${levelColors[log.level] ?? 'text-gray-400'}`}>
                  {log.level}
                </span>
                <span className="text-xs text-gray-500">{formatTimestamp(log.timestamp)}</span>
              </div>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-white text-lg px-2"
              >
                ✕
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {/* Parsed fields */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Fields</h3>
                <div className="font-mono text-xs">
                  <Field label="message" value={log.message} />
                  {log.service && <Field label="service" value={log.service} color="text-blue-400" />}
                  {log.podName && <Field label="pod" value={log.podName} color="text-purple-400" />}
                  {log.error && <Field label="error" value={log.error} color="text-red-400" />}
                </div>
              </section>

              {/* Stack trace */}
              {log.stackTrace && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Stack Trace</h3>
                  <pre className="text-xs text-red-300 font-mono bg-gray-950 rounded p-3 overflow-auto whitespace-pre-wrap">
                    {log.stackTrace}
                  </pre>
                </section>
              )}

              {/* Extra fields */}
              {Object.keys(log.extra).length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Extra</h3>
                  <pre className="text-xs text-gray-300 font-mono bg-gray-950 rounded p-3 overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(log.extra, null, 2)}
                  </pre>
                </section>
              )}

              {/* Raw JSON */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Raw</h3>
                <pre className="text-xs text-gray-300 font-mono bg-gray-950 rounded p-3 overflow-auto whitespace-pre-wrap">
                  {log.isJson ? prettyRaw(log.raw) : log.raw}
                </pre>
              </section>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
