import { useState } from 'react';
import { useApi } from './useApi';

export function useNamespaces(preferred: string | null = null) {
  const { data: namespaces, error } = useApi<string[]>('/api/namespaces');
  const [selected, setSelected] = useState<string | null>(preferred);

  const namespace = namespaces
    ? (selected && namespaces.includes(selected) ? selected : namespaces[0] ?? null)
    : null;

  return { namespaces, namespace, setNamespace: setSelected, error };
}
