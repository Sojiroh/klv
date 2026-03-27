import { useEffect } from 'react';
import { type ParsedLog } from '../types';
import { formatTimestamp, levelBg, levelColors, prettyRaw } from '../utils/log-utils';

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex gap-3 py-1.5 border-b border-klv-border-subtle last:border-0">
      <span className="text-klv-text-muted shrink-0 w-20 text-right">{label}</span>
      <span className={`${color ?? 'text-klv-text-secondary'} break-all`}>{value}</span>
    </div>
  );
}

export default function LogDetailPanel({ log, onClose }: { log: ParsedLog | null; onClose: () => void }) {
  useEffect(() => {
    if (!log) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [log, onClose]);

  if (!log) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40 animate-fade-in"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full w-full sm:w-[520px] lg:w-[600px]
                    bg-klv-surface border-l border-klv-border z-50
                    animate-slide-in-right"
      >
        {log && (
          <div className="h-full flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-klv-border">
              <div className="flex items-center gap-3">
                <span className={`klv-badge ${levelBg[log.level] ?? ''} ${levelColors[log.level] ?? 'text-zinc-400'} font-semibold`}>
                  {log.level}
                </span>
                <span className="text-xs text-klv-text-muted font-mono">{formatTimestamp(log.timestamp)}</span>
              </div>
              <button
                onClick={onClose}
                className="w-7 h-7 flex items-center justify-center rounded-md
                           text-klv-text-muted hover:text-klv-text hover:bg-klv-elevated
                           transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-5 space-y-5">
              {/* Fields */}
              <section>
                <h3 className="klv-section-label mb-2">Fields</h3>
                <div className="klv-card p-3 font-mono text-xs">
                  <Field label="message" value={log.message} />
                  {log.service && <Field label="service" value={log.service} color="text-sky-400" />}
                  {log.podName && <Field label="pod" value={log.podName} color="text-violet-400" />}
                  {log.error && <Field label="error" value={log.error} color="text-red-400" />}
                </div>
              </section>

              {/* Stack trace */}
              {log.stackTrace && (
                <section>
                  <h3 className="klv-section-label mb-2">Stack Trace</h3>
                  <pre className="text-xs text-red-300/90 font-mono bg-red-950/20 border border-red-900/30
                                  rounded-lg p-4 overflow-auto whitespace-pre-wrap">
                    {log.stackTrace}
                  </pre>
                </section>
              )}

              {/* Extra fields */}
              {Object.keys(log.extra).length > 0 && (
                <section>
                  <h3 className="klv-section-label mb-2">Extra</h3>
                  <pre className="text-xs text-klv-text-secondary font-mono bg-klv-base rounded-lg
                                  border border-klv-border p-4 overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(log.extra, null, 2)}
                  </pre>
                </section>
              )}

              {/* Raw */}
              <section>
                <h3 className="klv-section-label mb-2">Raw</h3>
                <pre className="text-xs text-klv-text-secondary font-mono bg-klv-base rounded-lg
                                border border-klv-border p-4 overflow-auto whitespace-pre-wrap">
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
