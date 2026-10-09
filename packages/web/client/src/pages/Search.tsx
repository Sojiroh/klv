import { useState, useRef, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useNamespaces } from '../hooks/useNamespaces';
import VirtualLogList from '../components/VirtualLogList';
import ErrorNotice from '../components/ErrorNotice';
import FailedPodsWarning from '../components/FailedPodsWarning';
import LogDetailPanel from '../components/LogDetailPanel';
import { type FailedPod, type LogsResponse, type ParsedLog, type Pod } from '../types';
import { apiRequest, errorMessage } from '../lib/api';

interface SearchResults {
  term: string;
  logs: ParsedLog[];
  failedPods: FailedPod[];
}

export default function Search() {
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces();
  const [container, setContainer] = useState('');
  const [term, setTerm] = useState('');
  const [level, setLevel] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<ParsedLog | null>(null);
  const searching = useRef(false);
  const ns = namespace ? encodeURIComponent(namespace) : null;
  const { data: pods, error: podsError } = useApi<Pick<Pod, 'name' | 'containers'>[]>(
    ns ? `/api/pods/${ns}` : null,
  );

  const containers = useMemo(() => {
    if (!pods) return [];
    return [...new Set(pods.flatMap((p) => p.containers))];
  }, [pods]);

  const handleSearch = async () => {
    if (searching.current || !term.trim() || !ns) return;
    searching.current = true;
    setLoading(true);
    setSearchError(null);
    const executedTerm = term;
    try {
      const query = new URLSearchParams({ search: executedTerm });
      if (level) query.set('level', level);

      if (container) {
        const data = await apiRequest<LogsResponse>(
          `/api/pods/${ns}/container/${encodeURIComponent(container)}/logs?${query}`,
        );
        setResults({ term: executedTerm, logs: data.logs, failedPods: data.failedPods ?? [] });
        return;
      }

      const podList = await apiRequest<Pod[]>(`/api/pods/${ns}`);
      const targets = podList.flatMap((pod) => pod.containers.map((c) => ({ pod: pod.name, container: c })));
      const settled = await Promise.allSettled(
        targets.map(({ pod, container: c }) => {
          const podQuery = new URLSearchParams(query);
          podQuery.set('container', c);
          return apiRequest<LogsResponse>(
            `/api/pods/${ns}/${encodeURIComponent(pod)}/logs?${podQuery}`,
          );
        }),
      );

      const logs: ParsedLog[] = [];
      const failedPods: FailedPod[] = [];
      settled.forEach((result, i) => {
        const { pod, container: c } = targets[i];
        if (result.status === 'fulfilled') {
          for (const log of result.value.logs) logs.push(log.podName ? log : { ...log, podName: pod });
        } else {
          failedPods.push({ pod: `${pod}/${c}`, error: errorMessage(result.reason) });
        }
      });
      setResults({ term: executedTerm, logs, failedPods });
    } catch (err) {
      setSearchError(errorMessage(err));
    } finally {
      searching.current = false;
      setLoading(false);
    }
  };

  const error = searchError ?? namespacesError ?? podsError;

  return (
    <div className="stagger-children">
      <h2 className="text-xl font-display font-bold tracking-tight mb-6">Search</h2>

      {/* Search form */}
      <div className="klv-card p-5 mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="klv-section-label">Namespace</span>
            <select
              value={namespace ?? ''}
              onChange={(e) => { setNamespace(e.target.value); setContainer(''); }}
              className="klv-select"
            >
              {namespaces?.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
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
            disabled={loading || !term.trim() || !namespace}
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

      {error && <ErrorNotice message={error} />}

      {/* Results */}
      {results !== null && (
        <div className="animate-slide-up">
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-sm text-klv-text-secondary font-body">
              {results.logs.length} result{results.logs.length !== 1 ? 's' : ''}
            </span>
            <span className="text-sm text-klv-text-muted">
              for <span className="font-mono text-klv-accent">"{results.term}"</span>
            </span>
          </div>

          <FailedPodsWarning failedPods={results.failedPods} />

          <VirtualLogList
            logs={results.logs}
            maxHeight="calc(100vh - 340px)"
            showPodName
            onSelect={setSelectedLog}
            empty={<p className="text-klv-text-muted text-center py-8 text-sm">No results found</p>}
          />
        </div>
      )}

      <LogDetailPanel log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}
