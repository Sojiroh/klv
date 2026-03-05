import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import LogLine from '../components/LogLine';
import LogFilters from '../components/LogFilters';

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

export default function Logs() {
  const { namespace, pod } = useParams<{ namespace: string; pod: string }>();
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  const params = new URLSearchParams();
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
        </h2>
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
          <LogLine key={i} log={log} showRaw={showRaw} />
        ))}
        {data?.logs.length === 0 && (
          <p className="text-gray-500 text-center py-4">No logs found</p>
        )}
      </div>
    </div>
  );
}
