import { useState, useEffect, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useExplorerParams } from '../hooks/useExplorerParams';
import { useNamespaces } from '../hooks/useNamespaces';
import { usePersistentState } from '../hooks/usePersistentState';
import { useStream } from '../hooks/useStream';
import ErrorNotice from '../components/ErrorNotice';
import Explorer from '../components/explorer/Explorer';
import { type ParsedLog, type Pod } from '../types';

/** Persisted sentinel: keep every line (the hook receives Infinity). */
const UNLIMITED = 0;
const BUFFER_SIZES = [2000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, UNLIMITED];
const DEFAULT_BUFFER_SIZE = 10000;
/** From this size on the memory estimate is shown next to the counter. */
const LARGE_BUFFER = 100000;

function formatMb(bytes: number): string {
  const mb = bytes / 1_048_576;
  return mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString();
}

function BufferSelect({ value, onChange }: { value: number; onChange: (size: number) => void }) {
  return (
    <label className="flex items-center gap-2" title="Maximum number of lines kept in memory; the oldest are dropped. Unlimited keeps every line">
      <span className="klv-section-label">Buffer</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="klv-select !py-1 text-xs font-mono"
      >
        {BUFFER_SIZES.map((n) => (
          <option key={n} value={n}>{n === UNLIMITED ? 'Unlimited' : n.toLocaleString()}</option>
        ))}
      </select>
    </label>
  );
}

function UnlimitedWarning({ bytes }: { bytes: number }) {
  return (
    <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
      Unlimited buffer: every line stays in this tab's memory (≈ {formatMb(bytes)} MB now, roughly 1 GB per million
      lines). Past a few hundred thousand lines the page gets slow and may crash — Clear from time to time, or record
      the pods with the History collector for long sessions.
    </p>
  );
}

export default function Stream() {
  const params = useExplorerParams('24h');
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces();
  const [selectedContainer, setSelectedContainer] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [frozen, setFrozen] = useState<ParsedLog[] | null>(null);
  const [storedBufferSize, setBufferSize] = usePersistentState('klv.stream.bufferSize', DEFAULT_BUFFER_SIZE);
  const bufferSize = BUFFER_SIZES.includes(storedBufferSize) ? storedBufferSize : DEFAULT_BUFFER_SIZE;
  const unlimited = bufferSize === UNLIMITED;

  const { data: pods, error: podsError } = useApi<Pod[]>(
    namespace ? `/api/pods/${encodeURIComponent(namespace)}` : null,
  );
  const { logs, dropped, approxBytes, notices, connected, streaming, start, stop, clear } = useStream({
    bufferSize: unlimited ? Infinity : bufferSize,
  });

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
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 animate-pulse-dot' : 'bg-red-500'}`} />
          <span className={`text-xs font-mono ${connected ? 'text-emerald-600' : 'text-red-600'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      {error && <ErrorNotice message={error} />}

      {/* Setup controls */}
      {!streaming && (
        <div className="klv-card p-5 mb-5 space-y-4">
          <div className="flex flex-wrap items-center gap-4">
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
            <div className="ml-auto">
              <BufferSelect value={bufferSize} onChange={setBufferSize} />
            </div>
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
                          ? 'border-klv-accent/50 text-klv-accent bg-klv-accent/10'
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
                <span className="text-klv-text-secondary ml-1.5 text-xs">
                  ({podCount} pod{podCount !== 1 ? 's' : ''} / {selectedContainer || '...'})
                </span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Streaming controls */}
      {streaming && (
        <div className="flex flex-wrap items-center gap-3 mb-4 animate-fade-in">
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

          <BufferSelect value={bufferSize} onChange={setBufferSize} />

          <span className="text-xs text-klv-text-muted font-mono ml-auto flex items-center gap-3">
            {dropped > 0 && (
              <span className="text-amber-600" title="Lines discarded because the buffer was full">
                {dropped.toLocaleString()} dropped
              </span>
            )}
            <span title="Lines currently in memory">
              {displayed.length.toLocaleString()} buffered{paused && ' (paused)'}
              {(unlimited || bufferSize >= LARGE_BUFFER) && ` · ≈ ${formatMb(approxBytes)} MB`}
            </span>
          </span>
        </div>
      )}

      {streaming && unlimited && <UnlimitedWarning bytes={approxBytes} />}

      {notices.length > 0 && (
        <div className="klv-card px-4 py-3 mb-4 max-h-32 overflow-auto text-xs font-mono space-y-0.5">
          {notices.map((n, i) => (
            <p key={i} className={n.kind === 'error' ? 'text-red-600' : 'text-klv-text-muted'}>
              {n.podName ? `${n.podName}: ` : ''}{n.message}
            </p>
          ))}
        </div>
      )}

      {/* Explorer over the live buffer (filtering is client-side; the stream is never restarted) */}
      {(streaming || displayed.length > 0) && (
        <Explorer
          params={params}
          source="kubelet"
          logs={displayed}
          showRange={false}
          followTail={streaming && autoScroll && !paused}
          scope={{ namespace: namespace ?? undefined, container: selectedContainer || undefined }}
          exportName={`stream-${selectedContainer || 'logs'}`}
          maxHeight="max(320px, calc(100vh - 520px))"
          emptyMessage={
            streaming ? (
              <>
                <span className="inline-block w-2 h-2 rounded-full bg-klv-accent animate-pulse-dot mr-2" />
                Waiting for logs...
              </>
            ) : (
              'No logs'
            )
          }
          onLogSelect={() => {
            if (streaming && !paused) setFrozen(logs);
          }}
        />
      )}
    </div>
  );
}
