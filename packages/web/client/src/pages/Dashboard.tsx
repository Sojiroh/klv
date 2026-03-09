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
    <div>
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

      <h2 className="text-lg font-semibold mb-4">
        Containers in <span className="text-cyan-400">{namespace}</span>
      </h2>

      {loading && <p className="text-gray-500">Loading containers...</p>}
      {groups.length > 0 && <ContainerTable groups={groups} namespace={namespace} />}
    </div>
  );
}
