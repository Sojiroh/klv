import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useNamespaces } from '../hooks/useNamespaces';
import NamespaceSelector from '../components/NamespaceSelector';
import ContainerTable, { type ContainerGroup } from '../components/ContainerTable';
import ErrorNotice from '../components/ErrorNotice';
import { apiRequest, errorMessage } from '../lib/api';
import { type Pod } from '../types';

// Refresh cadence while pods are starting or terminating (e.g. after deleting one)
const TRANSITION_POLL_MS = 3000;

export default function Dashboard() {
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces();
  const { data: pods, loading, error: podsError, settled, reload } = useApi<Pod[]>(
    namespace ? `/api/pods/${encodeURIComponent(namespace)}` : null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const transitioning = pods?.some((p) => p.status === 'Pending' || p.status === 'Terminating') ?? false;

  // Every response (a failed one too, which keeps the same data) schedules the next poll while the last known
  // pods are starting or terminating; a single timer is pending at any time
  useEffect(() => {
    if (!transitioning) return;
    const timer = setTimeout(reload, TRANSITION_POLL_MS);
    return () => clearTimeout(timer);
  }, [transitioning, settled, reload]);

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

  // A Map: container names such as `constructor` are valid and must not hit inherited object members
  const groupsByContainer = new Map<string, ContainerGroup>();
  for (const pod of pods ?? []) {
    for (const c of pod.containers) {
      let group = groupsByContainer.get(c);
      if (!group) {
        group = { container: c, podCount: 0, restarts: 0, statuses: [], pods: [] };
        groupsByContainer.set(c, group);
      }
      const restarts = (Object.hasOwn(pod.restarts, c) ? pod.restarts[c] : undefined) ?? 0;
      group.podCount++;
      group.restarts += restarts;
      group.pods.push({ name: pod.name, status: pod.status, age: pod.age, restarts });
      if (!group.statuses.includes(pod.status)) group.statuses.push(pod.status);
    }
  }
  const groups = [...groupsByContainer.values()];

  const error = namespacesError ?? podsError;

  return (
    <div className="stagger-children">
      {namespaces && namespace && (
        <NamespaceSelector namespaces={namespaces} namespace={namespace} onChange={changeNamespace} />
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
