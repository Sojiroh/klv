import { useState } from 'react';
import { useContexts } from '../hooks/useContexts';
import { useDeployments } from '../hooks/useDeployments';
import { useNamespaces } from '../hooks/useNamespaces';
import ContextSelector from '../components/ContextSelector';
import ErrorNotice from '../components/ErrorNotice';
import { apiRequest, errorMessage } from '../lib/api';
import { rolloutState } from '../lib/rollout';
import { formatTimestamp, rolloutStyles } from '../utils/log-utils';
import type { Deployment } from '../types';

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

export default function Deployments() {
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces();
  const { contexts, error: ctxError, switchContext } = useContexts();
  const { deployments, loading, error: listError, rolling, refresh, replace } = useDeployments(namespace);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const changeNamespace = (ns: string) => {
    setConfirming(null);
    setActionError(null);
    setNamespace(ns);
  };

  const restart = async (name: string) => {
    if (!namespace) return;
    setRestarting(name);
    setActionError(null);
    try {
      const updated = await apiRequest<Deployment>(
        `/api/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/restart`,
        { method: 'POST', body: {} },
      );
      replace(updated);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setRestarting(null);
      setConfirming(null);
    }
  };

  const error = ctxError ?? namespacesError ?? listError;
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
      {actionError && <ErrorNotice message={actionError} />}

      <div className="flex items-baseline gap-3 mb-5">
        <h2 className="text-xl font-display font-bold tracking-tight">Deployments</h2>
        {namespace && (
          <span className="text-sm text-klv-text-muted">
            in <span className="text-klv-accent font-mono">{namespace}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 self-center">
          {rolling && (
            <span className="flex items-center gap-1.5 text-xs text-blue-600">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse-dot" />
              Following rollout
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

      {loading && (
        <div className="klv-card px-6 py-12 text-center animate-pulse">
          <p className="text-klv-text-muted font-body">Loading deployments...</p>
        </div>
      )}

      {deployments && deployments.length === 0 && (
        <div className="klv-card px-6 py-12 text-center">
          <p className="text-klv-text-muted font-body">No deployments found</p>
        </div>
      )}

      {deployments && deployments.length > 0 && (
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
                {/* Wide enough for the inline confirmation, so columns don't shift when it opens */}
                <th className="py-3 px-4 text-right klv-section-label w-[300px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-klv-border-subtle">
              {deployments.map((d) => (
                <DeploymentRow
                  key={d.name}
                  deployment={d}
                  now={now}
                  confirming={confirming === d.name}
                  restarting={restarting === d.name}
                  onAsk={() => setConfirming(d.name)}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => void restart(d.name)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  deployment: Deployment;
  now: number;
  confirming: boolean;
  restarting: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeploymentRow({ deployment: d, now, confirming, restarting, onAsk, onCancel, onConfirm }: RowProps) {
  const state = rolloutState(d);
  const style = rolloutStyles[state.phase];

  return (
    <tr className={`transition-colors duration-150 ${confirming ? 'bg-klv-base/60' : 'hover:bg-klv-surface/50'}`}>
      <td className="py-3 px-4">
        <span className="font-mono text-sm text-klv-text">{d.name}</span>
      </td>
      <td className="py-3 px-4">
        <span className={`font-mono ${d.ready < d.desired ? 'text-amber-600' : 'text-klv-text-secondary'}`}>
          {d.ready}/{d.desired}
        </span>
      </td>
      <td className="py-3 px-4 font-mono text-klv-text-secondary">{d.updated}</td>
      <td className="py-3 px-4 font-mono text-klv-text-secondary">{d.available}</td>
      <td className="py-3 px-4">
        <div className="flex flex-col gap-1">
          <span className={`klv-badge border border-klv-border bg-klv-elevated w-fit ${style.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${style.dot} mr-1.5`} />
            {style.label}
          </span>
          {state.detail && state.phase !== 'paused' && (
            <span className="text-[11px] text-klv-text-muted max-w-[260px] truncate" title={state.detail}>
              {state.detail}
            </span>
          )}
        </div>
      </td>
      <td className="py-3 px-4">
        {d.restartedAt ? (
          <span className="text-xs text-klv-text-secondary" title={formatTimestamp(d.restartedAt)}>
            {timeAgo(d.restartedAt, now)}
          </span>
        ) : (
          <span className="text-xs text-klv-text-muted">—</span>
        )}
      </td>
      <td className="py-3 px-4">
        <span className="text-xs text-klv-text-muted">{d.age}</span>
      </td>
      <td className="py-3 px-4">
        {confirming ? (
          <div className="flex items-center justify-end gap-2">
            <span className="text-xs text-klv-text-secondary whitespace-nowrap">Replace all pods?</span>
            <button
              type="button"
              onClick={onCancel}
              disabled={restarting}
              className="klv-btn-secondary !px-2.5 !py-1 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={restarting}
              className="klv-btn-primary !px-2.5 !py-1 text-xs whitespace-nowrap"
            >
              {restarting ? 'Restarting…' : 'Restart'}
            </button>
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onAsk}
              disabled={d.paused}
              title={d.paused
                ? 'Resume the rollout before restarting'
                : 'Replace all pods following the rollout strategy (kubectl rollout restart)'}
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
