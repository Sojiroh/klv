import { useState, useEffect, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useNamespaces } from '../hooks/useNamespaces';
import { useStream } from '../hooks/useStream';
import VirtualLogList from '../components/VirtualLogList';
import ErrorNotice from '../components/ErrorNotice';
import LogDetailPanel from '../components/LogDetailPanel';
import { type ParsedLog, type Pod } from '../types';

export default function Stream() {
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces();
  const [selectedContainer, setSelectedContainer] = useState('');
  const [selectedLog, setSelectedLog] = useState<ParsedLog | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [frozen, setFrozen] = useState<ParsedLog[] | null>(null);

  const { data: pods, error: podsError } = useApi<Pod[]>(
    namespace ? `/api/pods/${encodeURIComponent(namespace)}` : null,
  );
  const { logs, notices, connected, streaming, start, stop, clear } = useStream();

  const paused = frozen !== null;
  const displayed = frozen ?? logs;

  useEffect(() => {
    if (!streaming) setFrozen(null);
  }, [streaming]);

  const containers = useMemo(() => {
    if (!pods) return [];
    return [...new Set(pods.flatMap((p) => p.containers))];
  }, [pods]);

  const targetPods = useMemo(() => {
    if (!pods) return [];
    return selectedContainer ? pods.filter((p) => p.containers.includes(selectedContainer)) : pods;
  }, [pods, selectedContainer]);

  const podCount = targetPods.length;

  const handleStart = () => {
    if (!selectedContainer || !namespace || targetPods.length === 0) return;
    void start({
      namespace,
      pods: targetPods.map((p) => p.name),
      container: selectedContainer,
    });
  };

  const handleStop = () => {
    stop();
    setFrozen(null);
  };

  const handleClear = () => {
    clear();
    if (paused) setFrozen([]);
  };

  const togglePause = () => setFrozen(paused ? null : logs);

  const error = namespacesError ?? podsError;

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

      {error && <ErrorNotice message={error} />}

      {/* Setup controls */}
      {!streaming && (
        <div className="klv-card p-5 mb-5 space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="klv-section-label">Namespace</span>
              <select
                value={namespace ?? ''}
                onChange={(e) => { setNamespace(e.target.value); setSelectedContainer(''); }}
                className="klv-select"
              >
                {namespaces?.map((name) => (
                  <option key={name} value={name}>{name}</option>
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
                disabled={!selectedContainer || !connected || podCount === 0}
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
          <button onClick={handleStop} className="klv-btn-danger">
            Stop
          </button>
          <button
            onClick={togglePause}
            className="klv-btn-secondary"
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={handleClear} className="klv-btn-secondary">
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
            {displayed.length} logs{paused && ' (paused)'}
          </span>
        </div>
      )}

      {notices.length > 0 && (
        <div className="klv-card px-4 py-3 mb-4 max-h-32 overflow-auto text-xs font-mono space-y-0.5">
          {notices.map((n, i) => (
            <p key={i} className={n.kind === 'error' ? 'text-red-400' : 'text-klv-text-muted'}>
              {n.podName ? `${n.podName}: ` : ''}{n.message}
            </p>
          ))}
        </div>
      )}

      {/* Log output */}
      <VirtualLogList
        logs={displayed}
        maxHeight="calc(100vh - 280px)"
        followTail={autoScroll && !paused}
        showPodName
        onSelect={(log) => {
          setSelectedLog(log);
          if (streaming && !paused) setFrozen(logs);
        }}
        empty={streaming ? (
          <div className="text-center py-12">
            <span className="inline-block w-2 h-2 rounded-full bg-klv-accent animate-pulse-dot mr-2" />
            <span className="text-klv-text-muted text-sm">Waiting for logs...</span>
          </div>
        ) : null}
      />

      <LogDetailPanel log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}
