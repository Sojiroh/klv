import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useExplorerParams } from '../hooks/useExplorerParams';
import { resolveRange, sinceSeconds } from '../lib/time';
import ErrorNotice from '../components/ErrorNotice';
import FailedPodsWarning from '../components/FailedPodsWarning';
import CappedWarning from '../components/explorer/CappedWarning';
import Explorer from '../components/explorer/Explorer';
import LoadControls from '../components/explorer/LoadControls';
import { type LogsResponse, type Pod } from '../types';

export default function Logs() {
  const { namespace, pod, container: containerParam } = useParams<{
    namespace: string;
    pod?: string;
    container?: string;
  }>();
  const params = useExplorerParams('24h');
  const [reload, setReload] = useState(0);

  const isAggregated = !pod && !!containerParam;
  const containerFromQuery = params.searchParams.get('container') ?? '';

  const ns = encodeURIComponent(namespace ?? '');

  const { data: pods } = useApi<Pick<Pod, 'name' | 'containers'>[]>(!isAggregated ? `/api/pods/${ns}` : null);
  const currentPod = pods?.find((p) => p.name === pod);
  const containers = currentPod?.containers ?? [];
  const isMultiContainer = containers.length > 1;

  // `since` is relative to "now": capture it once per request so the URL (and the fetch) stays stable.
  const { range, tail, previous } = params;
  const request = useMemo(() => {
    const now = Date.now();
    return { now, since: sinceSeconds(resolveRange(range, now).from, now) };
  }, [range, tail, previous, containerFromQuery, namespace, pod, containerParam, reload]);

  const query = new URLSearchParams({ tail: String(tail), since: String(request.since) });
  if (!isAggregated && containerFromQuery) query.set('container', containerFromQuery);
  if (previous) query.set('previous', 'true');

  const apiUrl = isAggregated
    ? `/api/pods/${ns}/container/${encodeURIComponent(containerParam ?? '')}/logs?${query}`
    : `/api/pods/${ns}/${encodeURIComponent(pod ?? '')}/logs?${query}`;

  const { data, loading, error } = useApi<LogsResponse>(apiUrl);

  const logContainer = isAggregated
    ? containerParam
    : containerFromQuery || (containers.length === 1 ? containers[0] : undefined);

  const logs = useMemo(
    () => (data ? data.logs.map((l) => ({ ...l, namespace, container: logContainer, podName: l.podName ?? pod })) : []),
    [data, namespace, logContainer, pod],
  );

  const capped = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of logs) counts.set(l.podName ?? '', (counts.get(l.podName ?? '') ?? 0) + 1);
    return [...counts].filter(([, n]) => n >= tail).map(([name]) => name);
  }, [logs, tail]);

  return (
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
                <span className="klv-badge bg-violet-50 text-violet-700 border border-violet-200 text-[10px]">
                  {containerFromQuery}
                </span>
              )}
            </>
          )}
          {previous && (
            <span className="klv-badge bg-amber-50 text-amber-700 border border-amber-200 text-[10px]">
              previous
            </span>
          )}
        </h2>

        {!isAggregated && isMultiContainer && (
          <select
            value={containerFromQuery}
            onChange={(e) => params.update({ container: e.target.value })}
            className="klv-select text-xs"
          >
            <option value="">Default container</option>
            {containers.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>

      {error && <ErrorNotice message={error} />}

      <Explorer
        params={params}
        source="kubelet"
        logs={logs}
        loadedAt={request.now}
        loading={loading}
        scope={{ namespace, container: logContainer, previous }}
        exportName={`logs-${pod ?? containerParam ?? 'pod'}`}
        emptyMessage="No logs in this time range. Try a wider range or a larger tail."
        toolbar={<LoadControls params={params} loading={loading} onRefresh={() => setReload((n) => n + 1)} />}
        notices={
          <>
            <FailedPodsWarning failedPods={data?.failedPods} />
            <CappedWarning capped={capped} tail={tail} />
          </>
        }
      />
    </div>
  );
}
