import { useEffect, useState } from 'react';
import { apiRequest, errorMessage } from '../../lib/api';
import type { ColumnId } from '../../lib/columns';
import { logTime, sinceSeconds } from '../../lib/time';
import type { HistoryQueryRequest, HistoryQueryResponse, LogsResponse, ParsedLog } from '../../types';
import { formatTimestamp } from '../../utils/log-utils';
import LogTable from './LogTable';
import { XIcon } from './icons';

const CONTEXT_LINES = 50;
const WINDOW_MS = 5 * 60_000;
const FETCH_TAIL = 10_000;
const COLUMNS: ColumnId[] = ['time', 'level', 'service', 'message'];

export interface ContextScope {
  context?: string;
  namespace?: string;
  container?: string;
  previous?: boolean;
}

interface Props {
  log: ParsedLog;
  source: 'kubelet' | 'history';
  scope: ContextScope;
  onClose: () => void;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; lines: ParsedLog[]; index: number };

function locate(logs: ParsedLog[], target: ParsedLog): number {
  const exact = logs.findIndex((l) => l.k8sTimestamp === target.k8sTimestamp && l.raw === target.raw);
  return exact !== -1 ? exact : logs.findIndex((l) => l.raw === target.raw);
}

async function fetchWindow(log: ParsedLog, source: Props['source'], scope: ContextScope, signal: AbortSignal): Promise<ParsedLog[]> {
  const namespace = log.namespace ?? scope.namespace;
  const pod = log.podName;
  const container = log.container ?? scope.container;
  if (!namespace || !pod) throw new Error('This log has no pod/namespace, so its context cannot be loaded');
  const time = logTime(log);

  if (source === 'history') {
    if (time === null) throw new Error('This log has no timestamp, so its context cannot be loaded');
    const request: HistoryQueryRequest = {
      context: log.context ?? scope.context,
      namespace,
      pods: [pod],
      containers: container ? [container] : undefined,
      from: new Date(time - WINDOW_MS).toISOString(),
      to: new Date(time + WINDOW_MS).toISOString(),
      query: null,
      limit: FETCH_TAIL,
    };
    const response = await apiRequest<HistoryQueryResponse>('/api/history/query', { method: 'POST', body: request, signal });
    return response.logs;
  }

  const params = new URLSearchParams({ tail: String(FETCH_TAIL) });
  if (container) params.set('container', container);
  if (scope.previous) params.set('previous', 'true');
  if (time !== null) params.set('since', String(sinceSeconds(time - WINDOW_MS)));
  const response = await apiRequest<LogsResponse>(
    `/api/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/logs?${params}`,
    { signal },
  );
  return response.logs;
}

export default function ContextView({ log, source, scope, onClose }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchWindow(log, source, scope, controller.signal).then(
      (logs) => {
        if (controller.signal.aborted) return;
        const at = locate(logs, log);
        if (at === -1) {
          setState({
            status: 'error',
            message: `The line was not found in the fetched window (${logs.length.toLocaleString()} lines). It may have rotated out of the pod's log.`,
          });
          return;
        }
        const start = Math.max(0, at - CONTEXT_LINES);
        setState({ status: 'ready', lines: logs.slice(start, at + CONTEXT_LINES + 1), index: at - start });
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: errorMessage(err) });
      },
    );
    return () => controller.abort();
  }, [log, source, scope]);

  useEffect(() => {
    // Capture phase + stopPropagation so Escape only closes this dialog, not the detail panel below it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-8">
      <div className="absolute inset-0 bg-slate-900/30 animate-fade-in" onClick={onClose} />
      <div className="relative klv-card bg-klv-surface w-full max-w-[1100px] max-h-full flex flex-col shadow-xl shadow-slate-900/15 animate-slide-up">
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-klv-border">
          <div className="min-w-0">
            <h3 className="font-display font-bold tracking-tight">
              Context
              <span className="ml-2 text-xs font-mono font-normal text-klv-text-muted">
                ±{CONTEXT_LINES} lines · {log.podName}
                {(log.container ?? scope.container) && ` / ${log.container ?? scope.container}`}
                {scope.previous && source === 'kubelet' && ' (previous)'}
              </span>
            </h3>
            <p className="text-[11px] font-mono text-klv-text-muted mt-0.5">
              {formatTimestamp(log.k8sTimestamp ?? log.timestamp)}
              {source === 'history' && ' · from local history'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-klv-text-muted hover:text-klv-text hover:bg-klv-elevated transition-colors"
            title="Close (Esc)"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 min-h-0">
          {state.status === 'loading' && (
            <p className="py-12 text-center text-sm text-klv-text-muted animate-pulse">Loading context…</p>
          )}
          {state.status === 'error' && (
            <p className="py-10 px-6 text-center text-sm text-amber-600 font-mono break-words">{state.message}</p>
          )}
          {state.status === 'ready' && (
            <LogTable
              logs={state.lines}
              columns={COLUMNS}
              maxHeight="calc(100vh - 220px)"
              selected={state.lines[state.index]}
              scrollToIndex={state.index}
            />
          )}
        </div>
      </div>
    </div>
  );
}
