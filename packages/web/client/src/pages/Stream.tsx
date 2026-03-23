import { useState, useRef, useEffect, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useStream } from '../hooks/useStream';
import LogLine from '../components/LogLine';
import LogDetailPanel from '../components/LogDetailPanel';

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

interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  age: string;
}

export default function Stream() {
  const [namespace, setNamespace] = useState('default');
  const [selectedContainer, setSelectedContainer] = useState('');
  const [selectedLog, setSelectedLog] = useState<ParsedLog | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const { data: namespaces } = useApi<string[]>('/api/namespaces');
  const { data: pods } = useApi<Pod[]>(`/api/pods/${namespace}`);
  const { logs, connected, streaming, start, stop, clear } = useStream();

  useEffect(() => {
    if (autoScroll && !paused) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll, paused]);

  const containers = useMemo(() => {
    if (!pods) return [];
    return [...new Set(pods.flatMap((p) => p.containers))];
  }, [pods]);

  const podCount = pods?.length ?? 0;

  const handleStart = () => {
    if (!selectedContainer || !pods) return;
    start({
      namespace,
      pods: pods.map((p) => p.name),
      container: selectedContainer,
    });
  };

  return (
    <div className="stagger-children">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <h2 className="text-xl font-display font-bold tracking-tight">Stream</h2>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'}`} />
          <span className={`text-xs font-mono ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* Setup controls */}
      {!streaming && (
        <div className="klv-card p-5 mb-5 space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="klv-section-label">Namespace</span>
              <select
                value={namespace}
                onChange={(e) => { setNamespace(e.target.value); setSelectedContainer(''); }}
                className="klv-select"
              >
                {namespaces?.map((ns) => (
                  <option key={ns} value={ns}>{ns}</option>
                ))}
              </select>
            </div>
            <span className="klv-badge bg-klv-elevated text-klv-text-muted border border-klv-border">
              {podCount} pod{podCount !== 1 ? 's' : ''}
            </span>
          </div>

          {containers.length > 0 && (
            <>
              <div>
                <span className="klv-section-label mb-2 block">Container</span>
                <div className="flex flex-wrap gap-2">
                  {containers.map((c) => (
                    <button
                      key={c}
                      onClick={() => setSelectedContainer(selectedContainer === c ? '' : c)}
                      className={`px-3 py-1.5 text-xs rounded-lg border font-mono transition-all duration-200 ${
                        selectedContainer === c
                          ? 'border-klv-accent/50 text-klv-accent bg-klv-accent/10 shadow-[0_0_12px_rgba(249,115,22,0.1)]'
                          : 'border-klv-border text-klv-text-muted hover:border-klv-text-muted hover:text-klv-text-secondary'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div className="gradient-line" />

              <button
                onClick={handleStart}
                disabled={!selectedContainer}
                className="klv-btn-primary"
              >
                Start streaming
                <span className="text-white/60 ml-1.5 text-xs">
                  ({podCount} pod{podCount !== 1 ? 's' : ''} / {selectedContainer || '...'})
                </span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Streaming controls */}
      {streaming && (
        <div className="flex items-center gap-3 mb-4 animate-fade-in">
          <button onClick={stop} className="klv-btn-danger">
            Stop
          </button>
          <button
            onClick={() => setPaused(!paused)}
            className="klv-btn-secondary"
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={clear} className="klv-btn-secondary">
            Clear
          </button>

          <label className="flex items-center gap-2 text-sm text-klv-text-muted cursor-pointer ml-2">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-klv-accent"
            />
            Auto-scroll
          </label>

          <span className="text-xs text-klv-text-muted font-mono ml-auto">
            {logs.length} logs
          </span>
        </div>
      )}

      {/* Log output */}
      <div className="klv-log-container">
        {logs.map((log, i) => (
          <LogLine key={i} log={log} showRaw={false} onClick={!streaming || paused ? setSelectedLog : undefined} />
        ))}
        <div ref={logEndRef} />
        {logs.length === 0 && streaming && (
          <div className="text-center py-12">
            <span className="inline-block w-2 h-2 rounded-full bg-klv-accent animate-pulse-dot mr-2" />
            <span className="text-klv-text-muted text-sm">Waiting for logs...</span>
          </div>
        )}
      </div>

      <LogDetailPanel log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}
