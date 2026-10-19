import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useExplorerParams } from '../hooks/useExplorerParams';
import { useNamespaces } from '../hooks/useNamespaces';
import { apiRequest, errorMessage } from '../lib/api';
import { resolveRange, sinceSeconds } from '../lib/time';
import ErrorNotice from '../components/ErrorNotice';
import FailedPodsWarning from '../components/FailedPodsWarning';
import CappedWarning from '../components/explorer/CappedWarning';
import Explorer from '../components/explorer/Explorer';
import LoadControls from '../components/explorer/LoadControls';
import { cachedTime } from '../components/explorer/pipeline';
import { type FailedPod, type LogsResponse, type ParsedLog, type Pod } from '../types';

interface SearchResult {
  key: string;
  logs: ParsedLog[];
  failedPods: FailedPod[];
  capped: string[];
  trimmed: string[];
  error: string | null;
}

export default function Search() {
  const params = useExplorerParams('24h');
  const { searchParams, update, range, tail, previous } = params;
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces(searchParams.get('ns'));
  const container = searchParams.get('container') ?? '';
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);

  const ns = namespace ? encodeURIComponent(namespace) : null;
  const { data: pods, error: podsError } = useApi<Pick<Pod, 'name' | 'containers'>[]>(ns ? `/api/pods/${ns}` : null);

  const containers = useMemo(() => {
    if (!pods) return [];
    return [...new Set(pods.flatMap((p) => p.containers))];
  }, [pods]);

  const request = useMemo(() => {
    const now = Date.now();
    return { now, since: sinceSeconds(resolveRange(range, now).from, now) };
  }, [range, tail, previous, container, namespace, reload]);

  const loadKey = `${namespace}|${container}|${tail}|${previous}|${request.now}`;

  useEffect(() => {
    if (!namespace || !ns) return;
    let cancelled = false;

    const load = async (): Promise<Omit<SearchResult, 'key' | 'error'>> => {
      const query = new URLSearchParams({ tail: String(tail), since: String(request.since) });
      if (previous) query.set('previous', 'true');

      if (container) {
        const data = await apiRequest<LogsResponse>(
          `/api/pods/${ns}/container/${encodeURIComponent(container)}/logs?${query}`,
        );
        const logs = data.logs.map((l) => ({ ...l, namespace, container }));
        return {
          logs,
          failedPods: data.failedPods ?? [],
          capped: cappedPods(logs, tail),
          trimmed: data.truncatedPods ?? [],
        };
      }

      const podList = await apiRequest<Pod[]>(`/api/pods/${ns}`);
      const targets = podList.flatMap((pod) => pod.containers.map((c) => ({ pod: pod.name, container: c })));
      const settled = await Promise.allSettled(
        targets.map(({ pod, container: c }) => {
          const podQuery = new URLSearchParams(query);
          podQuery.set('container', c);
          return apiRequest<LogsResponse>(`/api/pods/${ns}/${encodeURIComponent(pod)}/logs?${podQuery}`);
        }),
      );

      const logs: ParsedLog[] = [];
      const failedPods: FailedPod[] = [];
      const trimmed: string[] = [];
      settled.forEach((outcome, i) => {
        const { pod, container: c } = targets[i];
        if (outcome.status === 'fulfilled') {
          if (outcome.value.truncated) trimmed.push(`${pod}/${c}`);
          for (const log of outcome.value.logs) logs.push({ ...log, namespace, container: c, podName: log.podName ?? pod });
        } else {
          failedPods.push({ pod: `${pod}/${c}`, error: errorMessage(outcome.reason) });
        }
      });
      return { logs, failedPods, capped: cappedPods(logs, tail), trimmed };
    };

    load().then(
      (data) => {
        if (cancelled) return;
        // Kubelet lines from different pods arrive grouped by pod: interleave them chronologically.
        data.logs.sort((a, b) => (cachedTime(a) ?? 0) - (cachedTime(b) ?? 0));
        setResult({ key: loadKey, error: null, ...data });
      },
      (err: unknown) => {
        if (!cancelled) setResult({ key: loadKey, logs: [], failedPods: [], capped: [], trimmed: [], error: errorMessage(err) });
      },
    );

    return () => {
      cancelled = true;
    };
    // loadKey encodes every input of the request
  }, [loadKey]);

  const current = result?.key === loadKey ? result : null;
  const loading = (!namespaces && !namespacesError) || (!!namespace && current === null);
  const error = current?.error ?? namespacesError ?? podsError;

  return (
    <div className="stagger-children">
      <h2 className="text-xl font-display font-bold tracking-tight mb-5">Search</h2>

      {/* Scope */}
      <div className="klv-card px-5 py-3 mb-4 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="klv-section-label">Namespace</span>
          <select
            value={namespace ?? ''}
            onChange={(e) => {
              setNamespace(e.target.value);
              update({ ns: e.target.value, container: null });
            }}
            className="klv-select"
          >
            {namespaces?.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="klv-section-label">Container</span>
          <select value={container} onChange={(e) => update({ container: e.target.value })} className="klv-select">
            <option value="">All containers</option>
            {containers.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <span className="text-xs text-klv-text-muted ml-auto">
          Searches the last <span className="font-mono text-klv-text-secondary">{tail.toLocaleString()}</span> lines of every pod in scope
        </span>
      </div>

      {error && <ErrorNotice message={error} />}

      <Explorer
        params={params}
        source="kubelet"
        logs={current?.logs ?? []}
        loadedAt={request.now}
        loading={loading}
        scope={{ namespace: namespace ?? undefined, container: container || undefined, previous }}
        exportName={`search-${namespace ?? 'namespace'}`}
        emptyMessage="No logs found in this namespace and time range"
        toolbar={<LoadControls params={params} loading={loading} onRefresh={() => setReload((n) => n + 1)} />}
        notices={
          <>
            <FailedPodsWarning failedPods={current?.failedPods} />
            <CappedWarning capped={current?.capped ?? []} trimmed={current?.trimmed ?? []} tail={tail} />
          </>
        }
      />
    </div>
  );
}

/** Pod / container pairs that returned at least `tail` lines (older lines may have been cut off). */
function cappedPods(logs: ParsedLog[], tail: number): string[] {
  const counts = new Map<string, number>();
  for (const log of logs) {
    const key = log.container ? `${log.podName}/${log.container}` : (log.podName ?? '');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= tail).map(([key]) => key);
}
