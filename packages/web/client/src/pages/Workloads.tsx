import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useContexts } from '../hooks/useContexts';
import { useNamespaces } from '../hooks/useNamespaces';
import { useWorkloads } from '../hooks/useWorkloads';
import ContextSelector from '../components/ContextSelector';
import ErrorNotice from '../components/ErrorNotice';
import { apiRequest, errorMessage } from '../lib/api';
import { rolloutState } from '../lib/rollout';
import { WORKLOAD_KINDS, WORKLOAD_RESOURCES } from '../lib/workloads';
import { formatTimestamp, rolloutStyles } from '../utils/log-utils';
import type { Workload, WorkloadKind } from '../types';

const TAB_LABELS: Record<WorkloadKind, string> = {
  Deployment: 'Deployments',
  StatefulSet: 'StatefulSets',
  DaemonSet: 'DaemonSets',
};

// spec.replicas is an int32
const MAX_REPLICAS = 2 ** 31 - 1;

type RowMode = 'restart' | 'scale';

function timeAgo(iso: string, now: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function RestartIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992V4.356M2.985 19.644v-4.992h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"
      />
    </svg>
  );
}

function ScaleIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5"
      />
    </svg>
  );
}

export default function Workloads() {
  const [params, setParams] = useSearchParams();
  const kind = WORKLOAD_KINDS.find((k) => WORKLOAD_RESOURCES[k] === params.get('kind')) ?? 'Deployment';
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces();
  const { contexts, error: ctxError, switchContext } = useContexts();
  const { workloads, loading, errors, pollMs, refresh, replace } = useWorkloads(namespace);
  // Row with an open confirmation (`Kind/name`) and row whose action is in flight
  const [open, setOpen] = useState<{ key: string; mode: RowMode } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const resetActions = () => {
    setOpen(null);
    setActionError(null);
  };

  const selectKind = (next: WorkloadKind) => {
    resetActions();
    setParams({ kind: WORKLOAD_RESOURCES[next] }, { replace: true });
  };

  const changeNamespace = (ns: string) => {
    resetActions();
    setNamespace(ns);
  };

  const runAction = async (w: Workload, action: 'restart' | 'scale', body: object) => {
    const key = `${w.kind}/${w.name}`;
    setBusy(key);
    setActionError(null);
    try {
      const resource = WORKLOAD_RESOURCES[w.kind];
      const updated = await apiRequest<Workload>(
        `/api/${resource}/${encodeURIComponent(w.namespace)}/${encodeURIComponent(w.name)}/${action}`,
        { method: 'POST', body },
      );
      replace(updated);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
      setOpen(null);
    }
  };

  const counts: Record<WorkloadKind, number> = { Deployment: 0, StatefulSet: 0, DaemonSet: 0 };
  for (const w of workloads ?? []) counts[w.kind]++;
  const rows = workloads?.filter((w) => w.kind === kind) ?? null;
  const error = ctxError ?? namespacesError;
  const now = Date.now();

  return (
    <div className="stagger-children">
      {contexts && (
        <ContextSelector
          contexts={contexts.contexts}
          current={contexts.current}
          onSwitch={switchContext}
          namespaces={namespaces}
          namespace={namespace}
          onNamespaceChange={changeNamespace}
        />
      )}

      {error && <ErrorNotice message={error} />}
      {errors.map((message) => <ErrorNotice key={message} message={message} />)}
      {actionError && <ErrorNotice message={actionError} />}

      <div className="flex items-baseline gap-3 mb-4">
        <h2 className="text-xl font-display font-bold tracking-tight">Workloads</h2>
        {namespace && (
          <span className="text-sm text-klv-text-muted">
            in <span className="text-klv-accent font-mono">{namespace}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 self-center">
          {pollMs !== null && (
            <span
              className="flex items-center gap-1.5 text-xs text-blue-600"
              title="Refreshes automatically while a workload is rolling out or has pods not ready"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse-dot" />
              Refreshing every {pollMs / 1000}s
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={!namespace}
            className="klv-btn-secondary !px-3 !py-1.5 text-xs"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 mb-4 border-b border-klv-border">
        {WORKLOAD_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => selectKind(k)}
            className={`-mb-px px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              k === kind
                ? 'border-klv-accent text-klv-text'
                : 'border-transparent text-klv-text-muted hover:text-klv-text'
            }`}
          >
            {TAB_LABELS[k]}
            <span className="ml-1.5 text-xs font-mono text-klv-text-muted">{workloads ? counts[k] : '–'}</span>
          </button>
        ))}
      </div>

      {loading && (
        <div className="klv-card px-6 py-12 text-center animate-pulse">
          <p className="text-klv-text-muted font-body">Loading workloads...</p>
        </div>
      )}

      {rows && rows.length === 0 && (
        <div className="klv-card px-6 py-12 text-center">
          <p className="text-klv-text-muted font-body">No {TAB_LABELS[kind].toLowerCase()} found</p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="klv-card overflow-hidden animate-slide-up">
          <table className="w-full text-sm font-body">
            <thead>
              <tr className="border-b border-klv-border bg-klv-surface">
                <th className="py-3 px-4 text-left klv-section-label">Name</th>
                <th className="py-3 px-4 text-left klv-section-label">Pods</th>
                <th className="py-3 px-4 text-left klv-section-label">Up-to-date</th>
                <th className="py-3 px-4 text-left klv-section-label">Available</th>
                <th className="py-3 px-4 text-left klv-section-label">Status</th>
                <th className="py-3 px-4 text-left klv-section-label">Restarted</th>
                <th className="py-3 px-4 text-left klv-section-label">Age</th>
                {/* Wide enough for the inline confirmations, so columns don't shift when one opens */}
                <th className="py-3 px-4 text-right klv-section-label w-[360px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-klv-border-subtle">
              {rows.map((w) => {
                const key = `${w.kind}/${w.name}`;
                return (
                  <WorkloadRow
                    key={key}
                    workload={w}
                    now={now}
                    mode={open?.key === key ? open.mode : null}
                    busy={busy === key}
                    onOpen={(mode) => setOpen({ key, mode })}
                    onCancel={() => setOpen(null)}
                    onRestart={() => void runAction(w, 'restart', {})}
                    onScale={(replicas) => void runAction(w, 'scale', { replicas })}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  workload: Workload;
  now: number;
  mode: RowMode | null;
  busy: boolean;
  onOpen: (mode: RowMode) => void;
  onCancel: () => void;
  onRestart: () => void;
  onScale: (replicas: number) => void;
}

function WorkloadRow({ workload: w, now, mode, busy, onOpen, onCancel, onRestart, onScale }: RowProps) {
  const state = rolloutState(w);
  const style = rolloutStyles[state.phase];

  return (
    <tr className={`transition-colors duration-150 ${mode ? 'bg-klv-base/60' : 'hover:bg-klv-surface/50'}`}>
      <td className="py-3 px-4">
        <span className="font-mono text-sm text-klv-text">{w.name}</span>
      </td>
      <td className="py-3 px-4">
        <span className={`font-mono ${w.ready < w.desired ? 'text-amber-600' : 'text-klv-text-secondary'}`}>
          {w.ready}/{w.desired}
        </span>
      </td>
      <td className="py-3 px-4 font-mono text-klv-text-secondary">{w.updated}</td>
      <td className="py-3 px-4 font-mono text-klv-text-secondary">{w.available}</td>
      <td className="py-3 px-4">
        <div className="flex flex-col gap-1">
          <span className={`klv-badge border border-klv-border bg-klv-elevated w-fit ${style.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${style.dot} mr-1.5`} />
            {style.label}
          </span>
          {state.detail && (
            <span className="text-[11px] text-klv-text-muted max-w-[260px] truncate" title={state.detail}>
              {state.detail}
            </span>
          )}
        </div>
      </td>
      <td className="py-3 px-4">
        {w.restartedAt ? (
          <span className="text-xs text-klv-text-secondary" title={formatTimestamp(w.restartedAt)}>
            {timeAgo(w.restartedAt, now)}
          </span>
        ) : (
          <span className="text-xs text-klv-text-muted">—</span>
        )}
      </td>
      <td className="py-3 px-4">
        <span className="text-xs text-klv-text-muted">{w.age}</span>
      </td>
      <td className="py-3 px-4">
        {mode === 'restart' && (
          <RestartConfirm workload={w} busy={busy} onCancel={onCancel} onConfirm={onRestart} />
        )}
        {mode === 'scale' && (
          <ScaleForm workload={w} busy={busy} onCancel={onCancel} onScale={onScale} />
        )}
        {mode === null && (
          <div className="flex justify-end gap-2">
            {w.kind !== 'DaemonSet' && (
              <button
                type="button"
                onClick={() => onOpen('scale')}
                title="Change the number of replicas (kubectl scale)"
                className="klv-btn-secondary !px-2.5 !py-1 text-xs inline-flex items-center gap-1.5"
              >
                <ScaleIcon />
                Scale
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpen('restart')}
              disabled={w.paused}
              title={w.paused
                ? 'Resume the rollout before restarting'
                : 'Replace all pods following the update strategy (kubectl rollout restart)'}
              className="klv-btn-secondary !px-2.5 !py-1 text-xs inline-flex items-center gap-1.5"
            >
              <RestartIcon />
              Restart
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

interface ConfirmProps {
  workload: Workload;
  busy: boolean;
  onCancel: () => void;
}

function RestartConfirm({ workload, busy, onCancel, onConfirm }: ConfirmProps & { onConfirm: () => void }) {
  const onDelete = workload.strategy === 'OnDelete';
  return (
    <div className="flex items-center justify-end gap-2">
      <span
        className="text-xs text-klv-text-secondary whitespace-nowrap"
        title={onDelete ? 'OnDelete strategy: running pods keep the old template until they are deleted' : undefined}
      >
        {onDelete ? 'Pods update when deleted. Restart?' : 'Replace all pods?'}
      </span>
      <button type="button" onClick={onCancel} disabled={busy} className="klv-btn-secondary !px-2.5 !py-1 text-xs">
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="klv-btn-primary !px-2.5 !py-1 text-xs whitespace-nowrap"
      >
        {busy ? 'Restarting…' : 'Restart'}
      </button>
    </div>
  );
}

function ScaleForm({ workload, busy, onCancel, onScale }: ConfirmProps & { onScale: (replicas: number) => void }) {
  const [draft, setDraft] = useState(String(workload.desired));
  const replicas = /^\d+$/.test(draft) ? Number(draft) : null;
  const valid = replicas !== null && replicas <= MAX_REPLICAS;
  const changed = replicas !== workload.desired;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && changed && replicas !== null) onScale(replicas);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
  };

  return (
    <form onSubmit={submit} onKeyDown={onKeyDown} className="flex items-center justify-end gap-2">
      <label className="text-xs text-klv-text-secondary whitespace-nowrap">
        Replicas
        <input
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          disabled={busy}
          className={`klv-input !px-2 !py-1 w-20 ml-2 text-xs font-mono ${valid ? '' : '!border-red-300'}`}
        />
      </label>
      <button type="button" onClick={onCancel} disabled={busy} className="klv-btn-secondary !px-2.5 !py-1 text-xs">
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy || !valid || !changed}
        title={replicas === 0 ? 'Stops every pod of this workload' : undefined}
        className={`${replicas === 0 ? 'klv-btn-danger' : 'klv-btn-primary'} !px-2.5 !py-1 text-xs whitespace-nowrap`}
      >
        {busy ? 'Scaling…' : replicas === 0 ? 'Scale to 0' : 'Scale'}
      </button>
    </form>
  );
}
