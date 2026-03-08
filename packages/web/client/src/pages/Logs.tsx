import { useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import LogLine from '../components/LogLine';
import LogFilters from '../components/LogFilters';
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

interface PodInfo {
  name: string;
  containers: string[];
}

export default function Logs() {
  const { namespace, pod } = useParams<{ namespace: string; pod: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [selectedLog, setSelectedLog] = useState<ParsedLog | null>(null);

  const container = searchParams.get('container') ?? '';

  const { data: pods } = useApi<PodInfo[]>(`/api/pods/${namespace}`);
  const currentPod = pods?.find((p) => p.name === pod);
  const containers = currentPod?.containers ?? [];
  const isMultiContainer = containers.length > 1;

  const handleContainerChange = (c: string) => {
    const next = new URLSearchParams(searchParams);
    if (c) {
      next.set('container', c);
    } else {
      next.delete('container');
    }
    setSearchParams(next, { replace: true });
  };

  const params = new URLSearchParams();
  if (container) params.set('container', container);
  if (level) params.set('level', level);
  if (search) params.set('search', search);

  const { data, loading } = useApi<{ logs: ParsedLog[]; total: number }>(
    `/api/pods/${namespace}/${pod}/logs?${params.toString()}`
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Link to="/" className="text-gray-400 hover:text-white text-sm">&larr; Back</Link>
        <h2 className="text-lg font-semibold">
          <span className="text-gray-400">{namespace}/</span>
          <span className="text-cyan-400">{pod}</span>
          {container && (
            <span className="text-purple-400 text-sm ml-2">({container})</span>
          )}
        </h2>
        {isMultiContainer && (
          <select
            value={container}
            onChange={(e) => handleContainerChange(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
          >
            <option value="">Default container</option>
            {containers.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        {data && (
          <span className="text-xs text-gray-500">
            {data.logs.length}/{data.total} logs
          </span>
        )}
      </div>

      <LogFilters
        level={level}
        search={search}
        showRaw={showRaw}
        onLevelChange={setLevel}
        onSearchChange={setSearch}
        onRawToggle={() => setShowRaw(!showRaw)}
      />

      {loading && <p className="text-gray-500">Loading logs...</p>}

      <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-[70vh]">
        {data?.logs.map((log, i) => (
          <LogLine key={i} log={log} showRaw={showRaw} onClick={setSelectedLog} />
        ))}
        {data?.logs.length === 0 && (
          <p className="text-gray-500 text-center py-4">No logs found</p>
        )}
      </div>

      <LogDetailPanel log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}
