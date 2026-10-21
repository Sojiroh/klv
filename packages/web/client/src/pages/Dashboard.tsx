import { useApi } from '../hooks/useApi';
import { useContexts } from '../hooks/useContexts';
import { useNamespaces } from '../hooks/useNamespaces';
import ContextSelector from '../components/ContextSelector';
import ContainerTable, { type ContainerGroup } from '../components/ContainerTable';
import ErrorNotice from '../components/ErrorNotice';
import { type Pod } from '../types';

export default function Dashboard() {
  const { namespaces, namespace, setNamespace, error: namespacesError } = useNamespaces();
  const { contexts: ctxData, error: ctxError, switchContext } = useContexts();
  const { data: pods, loading, error: podsError } = useApi<Pod[]>(
    namespace ? `/api/pods/${encodeURIComponent(namespace)}` : null,
  );

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
          onNamespaceChange={setNamespace}
        />
      )}

      {error && <ErrorNotice message={error} />}

      <div className="flex items-baseline gap-3 mb-5">
        <h2 className="text-xl font-display font-bold tracking-tight">
          Containers
        </h2>
        {namespace && (
          <span className="text-sm text-klv-text-muted">
            in <span className="text-klv-accent font-mono">{namespace}</span>
          </span>
        )}
      </div>

      {loading && (
        <div className="klv-card px-6 py-12 text-center animate-pulse">
          <p className="text-klv-text-muted font-body">Loading containers...</p>
        </div>
      )}

      {pods && namespace && <ContainerTable groups={groups} namespace={namespace} />}
    </div>
  );
}
