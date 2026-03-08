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
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-lg font-semibold">Stream</h2>
        <span className={`text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {!streaming && (
        <div className="mb-4">
          <div className="flex items-center gap-4 mb-3">
            <select
              value={namespace}
              onChange={(e) => { setNamespace(e.target.value); setSelectedContainer(''); }}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
            >
              {namespaces?.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </select>
            <span className="text-xs text-gray-500">{podCount} pod{podCount !== 1 ? 's' : ''}</span>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {containers.map((c) => (
              <button
                key={c}
                onClick={() => setSelectedContainer(selectedContainer === c ? '' : c)}
                className={`px-3 py-1 text-xs rounded border font-mono ${
                  selectedContainer === c
                    ? 'border-cyan-500 text-cyan-400 bg-cyan-500/10'
                    : 'border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          <button
            onClick={handleStart}
            disabled={!selectedContainer}
            className="px-4 py-2 bg-cyan-600 text-white rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-cyan-500"
          >
            Start streaming ({podCount} pod{podCount !== 1 ? 's' : ''} / {selectedContainer || '...'})
          </button>
        </div>
      )}

      {streaming && (
        <div className="flex items-center gap-3 mb-4">
          <button onClick={stop} className="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-500">
            Stop
          </button>
          <button
            onClick={() => setPaused(!paused)}
            className="px-4 py-2 bg-gray-700 text-white rounded text-sm hover:bg-gray-600"
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={clear} className="px-4 py-2 bg-gray-700 text-white rounded text-sm hover:bg-gray-600">
            Clear
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <span className="text-xs text-gray-500">{logs.length} logs</span>
        </div>
      )}

      <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[70vh]">
        {logs.map((log, i) => (
          <LogLine key={i} log={log} showRaw={false} onClick={setSelectedLog} />
        ))}
        <div ref={logEndRef} />
        {logs.length === 0 && streaming && (
          <p className="text-gray-500 text-center py-4">Waiting for logs...</p>
        )}
      </div>

      <LogDetailPanel log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}
