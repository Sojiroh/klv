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
  const { namespace, pod, container: containerParam } = useParams<{
    namespace: string;
    pod?: string;
    container?: string;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [selectedLog, setSelectedLog] = useState<ParsedLog | null>(null);

  const isAggregated = !pod && !!containerParam;

  const containerFromQuery = searchParams.get('container') ?? '';

  const handleContainerChange = (c: string) => {
    const next = new URLSearchParams(searchParams);
    if (c) {
      next.set('container', c);
    } else {
      next.delete('container');
    }
    setSearchParams(next, { replace: true });
  };

  const { data: pods } = useApi<PodInfo[]>(
    !isAggregated ? `/api/pods/${namespace}` : null,
  );
  const currentPod = pods?.find((p) => p.name === pod);
  const containers = currentPod?.containers ?? [];
  const isMultiContainer = containers.length > 1;

  const params = new URLSearchParams();
  if (!isAggregated && containerFromQuery) params.set('container', containerFromQuery);
  if (level) params.set('level', level);
  if (search) params.set('search', search);

  const apiUrl = isAggregated
    ? `/api/pods/${namespace}/container/${containerParam}/logs?${params.toString()}`
    : `/api/pods/${namespace}/${pod}/logs?${params.toString()}`;

  const { data, loading } = useApi<{ logs: ParsedLog[]; total: number; pods?: string[] }>(apiUrl);

  return (
    <>
      <div className="stagger-children">
        {/* Header */}
        <div className="flex items-center gap-4 mb-5">
          <Link
            to="/"
            className="w-7 h-7 flex items-center justify-center rounded-md
                       text-klv-text-muted hover:text-klv-text hover:bg-klv-elevated transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </Link>

          <h2 className="text-xl font-display font-bold tracking-tight flex items-baseline gap-2">
            <span className="text-klv-text-muted text-sm font-mono">{namespace}/</span>
            {isAggregated ? (
              <>
                <span className="text-klv-accent">{containerParam}</span>
                {data?.pods && (
                  <span className="klv-badge bg-klv-elevated text-klv-text-muted border border-klv-border text-[10px]">
                    {data.pods.length} pods
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="text-klv-accent">{pod}</span>
                {containerFromQuery && (
                  <span className="klv-badge bg-violet-500/10 text-violet-400 border border-violet-500/20 text-[10px]">
                    {containerFromQuery}
                  </span>
                )}
              </>
            )}
          </h2>

          {!isAggregated && isMultiContainer && (
            <select
              value={containerFromQuery}
              onChange={(e) => handleContainerChange(e.target.value)}
              className="klv-select text-xs"
            >
              <option value="">Default container</option>
              {containers.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}

          {data && (
            <span className="text-xs text-klv-text-muted font-mono ml-auto">
              {data.logs.length}<span className="text-klv-border mx-1">/</span>{data.total}
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

        {loading && (
          <div className="klv-card px-6 py-12 text-center animate-pulse">
            <p className="text-klv-text-muted">Loading logs...</p>
          </div>
        )}

        <div className="klv-log-container">
          {data?.logs.map((log, i) => (
            <LogLine key={i} log={log} showRaw={showRaw} onClick={setSelectedLog} showPodName={isAggregated} />
          ))}
          {data?.logs.length === 0 && (
            <p className="text-klv-text-muted text-center py-8 text-sm">No logs found</p>
          )}
        </div>
      </div>

      <LogDetailPanel log={selectedLog} onClose={() => setSelectedLog(null)} />
    </>
  );
}
