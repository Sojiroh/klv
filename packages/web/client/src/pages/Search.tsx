import { useState, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
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
  extra: Record<string, unknown>;
}

interface Pod {
  name: string;
  containers: string[];
}

export default function Search() {
  const [namespace, setNamespace] = useState('default');
  const [container, setContainer] = useState('');
  const [term, setTerm] = useState('');
  const [level, setLevel] = useState('');
  const [results, setResults] = useState<ParsedLog[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<ParsedLog | null>(null);
  const { data: namespaces } = useApi<string[]>('/api/namespaces');
  const { data: pods } = useApi<Pod[]>(`/api/pods/${namespace}`);

  const containers = useMemo(() => {
    if (!pods) return [];
    return [...new Set(pods.flatMap((p) => p.containers))];
  }, [pods]);

  const handleSearch = async () => {
    if (!term.trim()) return;
    setLoading(true);
    try {
      const podsRes = await fetch(`/api/pods/${namespace}`);
      const pods: { name: string }[] = await podsRes.json();

      const allLogs: ParsedLog[] = [];
      for (const pod of pods) {
        const params = new URLSearchParams({ search: term });
        if (level) params.set('level', level);
        if (container) params.set('container', container);
        const res = await fetch(`/api/pods/${namespace}/${pod.name}/logs?${params}`);
        const data: { logs: ParsedLog[] } = await res.json();
        allLogs.push(...data.logs);
      }
      setResults(allLogs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stagger-children">
      <h2 className="text-xl font-display font-bold tracking-tight mb-6">Search</h2>

      {/* Search form */}
      <div className="klv-card p-5 mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="klv-section-label">Namespace</span>
            <select
              value={namespace}
              onChange={(e) => { setNamespace(e.target.value); setContainer(''); }}
              className="klv-select"
            >
              {namespaces?.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              )) ?? <option value="default">default</option>}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="klv-section-label">Container</span>
            <select
              value={container}
              onChange={(e) => setContainer(e.target.value)}
              className="klv-select"
            >
              <option value="">All containers</option>
              {containers.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <span className="klv-section-label">Search term</span>
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-klv-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search across all pods..."
                className="klv-input w-full pl-9"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="klv-section-label">Level</span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="klv-select"
            >
              <option value="">All levels</option>
              <option value="DEBUG">DEBUG</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
            </select>
          </div>

          <button
            onClick={handleSearch}
            disabled={loading || !term.trim()}
            className="klv-btn-primary"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Searching...
              </span>
            ) : (
              'Search'
            )}
          </button>
        </div>
      </div>

      {/* Results */}
      {results !== null && (
        <div className="animate-slide-up">
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-sm text-klv-text-secondary font-body">
              {results.length} result{results.length !== 1 ? 's' : ''}
            </span>
            <span className="text-sm text-klv-text-muted">
              for <span className="font-mono text-klv-accent">"{term}"</span>
            </span>
          </div>

          <div className="klv-log-container">
            {results.map((log, i) => (
              <div key={i} className="flex gap-2 items-start">
                {log.podName && (
                  <span className="text-violet-400/80 font-mono text-xs shrink-0 w-40 truncate px-3 py-[5px]">
                    {log.podName}
                  </span>
                )}
                <LogLine log={log} showRaw={false} onClick={setSelectedLog} />
              </div>
            ))}
            {results.length === 0 && (
              <p className="text-klv-text-muted text-center py-8 text-sm">No results found</p>
            )}
          </div>
        </div>
      )}

      <LogDetailPanel log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}
