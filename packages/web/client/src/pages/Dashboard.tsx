import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import ContextSelector from '../components/ContextSelector';
import PodTable from '../components/PodTable';

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
        Pods in <span className="text-cyan-400">{namespace}</span>
      </h2>

      {loading && <p className="text-gray-500">Loading pods...</p>}
      {pods && <PodTable pods={pods} namespace={namespace} />}
    </div>
  );
}
