import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useContexts } from '../hooks/useContexts';
import { useNamespaces } from '../hooks/useNamespaces';
import ContextSelector from '../components/ContextSelector';
import ContainerTable, { type ContainerGroup } from '../components/ContainerTable';
import ErrorNotice from '../components/ErrorNotice';
import { apiRequest, errorMessage } from '../lib/api';
import { type Pod } from '../types';

// Refresh cadence while pods are starting or terminating (e.g. after deleting one)
const TRANSITION_POLL_MS = 3000;

export default function Dashboard() {
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces();
  const { contexts: ctxData, error: ctxError, switchContext } = useContexts();
  const { data: pods, loading, error: podsError, reload } = useApi<Pod[]>(
    namespace ? `/api/pods/${encodeURIComponent(namespace)}` : null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const transitioning = pods?.some((p) => p.status === 'Pending' || p.status === 'Terminating') ?? false;

  // Each response schedules the next poll while a pod is starting or terminating
  useEffect(() => {
    if (!transitioning) return;
    const timer = setTimeout(reload, TRANSITION_POLL_MS);
    return () => clearTimeout(timer);
  }, [transitioning, pods, reload]);

  const changeNamespace = (ns: string) => {
    setActionError(null);
    setNamespace(ns);
  };

  const deletePod = async (pod: string) => {
    if (!namespace) return;
    setActionError(null);
    try {
      await apiRequest<void>(
        `/api/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}`,
        { method: 'DELETE' },
      );
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const groups = Object.values(
    (pods ?? []).reduce<Record<string, ContainerGroup>>((acc, pod) => {
      for (const c of pod.containers) {
        if (!acc[c]) acc[c] = { container: c, podCount: 0, restarts: 0, statuses: [], pods: [] };
        const restarts = pod.restarts[c] ?? 0;
        acc[c].podCount++;
        acc[c].restarts += restarts;
        acc[c].pods.push({ name: pod.name, status: pod.status, age: pod.age, restarts });
        if (!acc[c].statuses.includes(pod.status)) acc[c].statuses.push(pod.status);
      }
      return acc;
    }, {}),
  );

  const error = ctxError ?? namespacesError ?? podsError;

  return (
    <div className="stagger-children">
      {ctxData && (
        <ContextSelector
          contexts={ctxData.contexts}
          current={ctxData.current}
          onSwitch={switchContext}
          namespaces={namespaces}
          namespace={namespace}
          onNamespaceChange={changeNamespace}
        />
      )}

      {error && <ErrorNotice message={error} />}
      {actionError && <ErrorNotice message={actionError} />}

      <div className="flex items-baseline gap-3 mb-5">
        <h2 className="text-xl font-display font-bold tracking-tight">
          Containers
        </h2>
        {namespace && (
          <span className="text-sm text-klv-text-muted">
            in <span className="text-klv-accent font-mono">{namespace}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 self-center">
          {transitioning && (
            <span
              className="flex items-center gap-1.5 text-xs text-blue-600"
              title="Refreshes automatically while pods are starting or terminating"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse-dot" />
              Refreshing every {TRANSITION_POLL_MS / 1000}s
            </span>
          )}
          <button
            type="button"
            onClick={reload}
            disabled={!namespace}
            className="klv-btn-secondary !px-3 !py-1.5 text-xs"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && (
        <div className="klv-card px-6 py-12 text-center animate-pulse">
          <p className="text-klv-text-muted font-body">Loading containers...</p>
        </div>
      )}

      {pods && namespace && <ContainerTable groups={groups} namespace={namespace} onDeletePod={deletePod} />}
    </div>
  );
}
