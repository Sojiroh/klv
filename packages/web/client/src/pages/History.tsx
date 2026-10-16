import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useExplorerParams } from '../hooks/useExplorerParams';
import { apiRequest, errorMessage } from '../lib/api';
import { parseQuery } from '../lib/query';
import { resolveRange } from '../lib/time';
import DebouncedInput from '../components/DebouncedInput';
import ErrorNotice from '../components/ErrorNotice';
import CollectorPanel from '../components/history/CollectorPanel';
import Explorer from '../components/explorer/Explorer';
import LoadControls from '../components/explorer/LoadControls';
import {
  type ContextsResponse,
  type HistoryLog,
  type HistoryQueryRequest,
  type HistoryQueryResponse,
  type Pod,
} from '../types';

interface HistoryState {
  key: string;
  logs: HistoryLog[];
  nextCursor: string | null;
  truncated: boolean;
  scanned: number;
  error: string | null;
  loadingMore: boolean;
}

export default function History() {
  const params = useExplorerParams('1h');
  const { searchParams, update, range, tail, query } = params;
  const tab = searchParams.get('tab') === 'collector' ? 'collector' : 'explore';
  const ctx = searchParams.get('ctx') ?? '';
  const ns = searchParams.get('ns') ?? '';
  const container = searchParams.get('container') ?? '';
  const podsParam = searchParams.get('pods') ?? '';
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<HistoryState | null>(null);

  const { data: contexts } = useApi<ContextsResponse>('/api/contexts');
  const { data: namespaces } = useApi<string[]>('/api/namespaces');
  const { data: pods } = useApi<Pick<Pod, 'name' | 'containers'>[]>(ns ? `/api/pods/${encodeURIComponent(ns)}` : null);
  const containerSuggestions = useMemo(() => [...new Set((pods ?? []).flatMap((p) => p.containers))], [pods]);

  const parsed = useMemo(() => parseQuery(query), [query]);

  const request = useMemo(() => {
    if (!parsed.ok || tab !== 'explore') return null;
    const now = Date.now();
    const { from, to } = resolveRange(range, now);
    const podNames = podsParam.split(',').map((p) => p.trim()).filter(Boolean);
    const body: HistoryQueryRequest = {
      context: ctx || undefined,
      namespace: ns || undefined,
      pods: podNames.length > 0 ? podNames : undefined,
      containers: container ? [container] : undefined,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      query: parsed.ast,
      limit: tail,
    };
    return { now, body, key: JSON.stringify(body) };
  }, [parsed, tab, range, tail, ctx, ns, container, podsParam, reload]);

  const requestKey = request?.key ?? null;

  useEffect(() => {
    if (!request) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    apiRequest<HistoryQueryResponse>('/api/history/query', { method: 'POST', body: request.body, signal: controller.signal }).then(
      (res) => {
        if (controller.signal.aborted) return;
        setState({
          key: request.key,
          logs: res.logs,
          nextCursor: res.nextCursor,
          truncated: res.truncated,
          scanned: res.scanned,
          error: null,
          loadingMore: false,
        });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ key: request.key, logs: [], nextCursor: null, truncated: false, scanned: 0, error: errorMessage(err), loadingMore: false });
      },
    );
    return () => controller.abort();
    // requestKey is the serialized request body
  }, [requestKey]);

  const current = state && state.key === requestKey ? state : null;

  const loadOlder = async () => {
    if (!request || !current?.nextCursor || current.loadingMore) return;
    const { key, body } = request;
    setState((prev) => (prev && prev.key === key ? { ...prev, loadingMore: true } : prev));
    try {
      const res = await apiRequest<HistoryQueryResponse>('/api/history/query', {
        method: 'POST',
        body: { ...body, before: current.nextCursor },
      });
      setState((prev) =>
        prev && prev.key === key
          ? {
              ...prev,
              logs: [...res.logs, ...prev.logs],
              nextCursor: res.nextCursor,
              truncated: res.truncated,
              scanned: prev.scanned + res.scanned,
              error: null,
              loadingMore: false,
            }
          : prev,
      );
    } catch (err) {
      setState((prev) => (prev && prev.key === key ? { ...prev, error: errorMessage(err), loadingMore: false } : prev));
    }
  };

  const loading = request !== null && current === null;

  return (
    <div className="stagger-children">
      <div className="flex items-center gap-4 mb-5">
        <h2 className="text-xl font-display font-bold tracking-tight">History</h2>
        <div className="flex items-center rounded-lg border border-klv-border bg-klv-elevated p-0.5">
          {([
            ['explore', 'Explorer'],
            ['collector', 'Collector'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => update({ tab: id === 'explore' ? null : id })}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                tab === id ? 'bg-klv-accent/15 text-klv-accent' : 'text-klv-text-muted hover:text-klv-text'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-klv-text-muted hidden sm:block">Logs stored locally by the collector</span>
      </div>

      {tab === 'collector' ? (
        <CollectorPanel />
      ) : (
        <>
          {/* Scope */}
          <div className="klv-card px-5 py-3 mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex items-center gap-2">
              <span className="klv-section-label">Context</span>
              <select value={ctx} onChange={(e) => update({ ctx: e.target.value })} className="klv-select">
                <option value="">All contexts</option>
                {contexts?.contexts.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="klv-section-label">Namespace</span>
              <DebouncedInput
                value={ns}
                onCommit={(v) => update({ ns: v.trim() })}
                list="history-namespaces"
                placeholder="All namespaces"
                className="klv-input !py-1.5 w-44 font-mono text-xs"
              />
              <datalist id="history-namespaces">
                {namespaces?.map((n) => <option key={n} value={n} />)}
              </datalist>
            </label>
            <label className="flex items-center gap-2">
              <span className="klv-section-label">Container</span>
              <DebouncedInput
                value={container}
                onCommit={(v) => update({ container: v.trim() })}
                list="history-containers"
                placeholder="All containers"
                className="klv-input !py-1.5 w-44 font-mono text-xs"
              />
              <datalist id="history-containers">
                {containerSuggestions.map((c) => <option key={c} value={c} />)}
              </datalist>
            </label>
            <label className="flex items-center gap-2">
              <span className="klv-section-label">Pods</span>
              <DebouncedInput
                value={podsParam}
                onCommit={(v) => update({ pods: v.trim() })}
                placeholder="pod-a, pod-b"
                className="klv-input !py-1.5 w-52 font-mono text-xs"
              />
            </label>
          </div>

          {current?.error && <ErrorNotice message={current.error} />}

          <Explorer
            params={params}
            source="history"
            logs={current?.logs ?? []}
            loadedAt={request?.now}
            loading={loading}
            scope={{ context: ctx || undefined, namespace: ns || undefined, container: container || undefined }}
            exportName="history"
            emptyMessage={
              <div className="space-y-2">
                <p>No stored logs match this scope, range and query.</p>
                <button
                  type="button"
                  onClick={() => update({ tab: 'collector' })}
                  className="text-klv-accent hover:text-klv-accent-hover text-xs"
                >
                  Configure the collector to record more logs →
                </button>
              </div>
            }
            toolbar={
              <LoadControls
                params={params}
                loading={loading}
                onRefresh={() => setReload((n) => n + 1)}
                limitLabel="Page"
                showPrevious={false}
              />
            }
            notices={
              current && (current.truncated || current.nextCursor) ? (
                <div
                  className={`klv-card px-4 py-2.5 flex flex-wrap items-center gap-3 text-xs ${
                    current.truncated ? 'border-amber-200 bg-amber-50 text-amber-700' : 'text-klv-text-muted'
                  }`}
                >
                  <span className="font-mono">
                    {current.logs.length.toLocaleString()} loaded · {current.scanned.toLocaleString()} rows scanned
                  </span>
                  {current.truncated && (
                    <span>The scan budget was exhausted before the page filled up: results may be incomplete.</span>
                  )}
                  {current.nextCursor && (
                    <button
                      type="button"
                      disabled={current.loadingMore}
                      onClick={() => void loadOlder()}
                      className="klv-btn-secondary !px-3 !py-1 text-xs ml-auto"
                    >
                      {current.loadingMore ? 'Loading…' : 'Load older'}
                    </button>
                  )}
                </div>
              ) : null
            }
          />
        </>
      )}
    </div>
  );
}
