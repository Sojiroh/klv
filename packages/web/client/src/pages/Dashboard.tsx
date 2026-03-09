import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import ContextSelector from '../components/ContextSelector';
import ContainerTable, { type ContainerGroup } from '../components/ContainerTable';

interface ContextsResponse {
  contexts: string[];
  current: string;
}

interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  age: string;
}

export default function Dashboard() {
  const [namespace, setNamespace] = useState('default');
  const { data: ctxData } = useApi<ContextsResponse>('/api/contexts');
  const { data: namespaces } = useApi<string[]>('/api/namespaces');
  const { data: pods, loading } = useApi<Pod[]>(`/api/pods/${namespace}`);

  const groups = Object.values(
    (pods ?? []).reduce<Record<string, ContainerGroup>>((acc, pod) => {
      for (const c of pod.containers) {
        if (!acc[c]) acc[c] = { container: c, podCount: 0, statuses: [], pods: [] };
        acc[c].podCount++;
        acc[c].pods.push({ name: pod.name, status: pod.status, age: pod.age });
        if (!acc[c].statuses.includes(pod.status)) acc[c].statuses.push(pod.status);
      }
      return acc;
    }, {}),
  );

  const handleContextSwitch = async (name: string) => {
    await fetch(`/api/contexts/${name}`, { method: 'PUT' });
    window.location.reload();
  };

  return (
    <div className="stagger-children">
      {ctxData && namespaces && (
        <ContextSelector
          contexts={ctxData.contexts}
          current={ctxData.current}
          onSwitch={handleContextSwitch}
          namespaces={namespaces}
          namespace={namespace}
          onNamespaceChange={setNamespace}
        />
      )}

      <div className="flex items-baseline gap-3 mb-5">
        <h2 className="text-xl font-display font-bold tracking-tight">
          Containers
        </h2>
        <span className="text-sm text-klv-text-muted">
          in <span className="text-klv-accent font-mono">{namespace}</span>
        </span>
      </div>

      {loading && (
        <div className="klv-card px-6 py-12 text-center animate-pulse">
          <p className="text-klv-text-muted font-body">Loading containers...</p>
        </div>
      )}

      {groups.length > 0 && <ContainerTable groups={groups} namespace={namespace} />}
    </div>
  );
}
