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
      // Search across all pods by fetching pods, then logs for each
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
    <div>
      <h2 className="text-lg font-semibold mb-4">Search</h2>

      <div className="flex items-center gap-3 mb-4">
        <select
          value={namespace}
          onChange={(e) => { setNamespace(e.target.value); setContainer(''); }}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
        >
          {namespaces?.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          )) ?? <option value="default">default</option>}
        </select>
        <select
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
        >
          <option value="">All containers</option>
          {containers.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          type="text"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search term..."
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 max-w-md"
        />
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
        >
          <option value="">All levels</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <button
          onClick={handleSearch}
          disabled={loading || !term.trim()}
          className="px-4 py-1.5 bg-cyan-600 text-white rounded text-sm disabled:opacity-50 hover:bg-cyan-500"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {results !== null && (
        <>
          <p className="text-sm text-gray-400 mb-3">
            {results.length} result{results.length !== 1 ? 's' : ''} for "{term}"
          </p>
          <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[70vh]">
            {results.map((log, i) => (
              <div key={i} className="flex gap-2 items-start">
                {log.podName && (
                  <span className="text-purple-400 font-mono text-xs shrink-0 w-40 truncate">
                    {log.podName}
                  </span>
                )}
                <LogLine log={log} showRaw={false} onClick={setSelectedLog} />
              </div>
            ))}
            {results.length === 0 && (
              <p className="text-gray-500 text-center py-4">No results found</p>
            )}
          </div>
        </>
      )}
      <LogDetailPanel log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}
