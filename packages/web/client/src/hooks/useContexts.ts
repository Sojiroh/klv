import { useState } from 'react';
import { useApi } from './useApi';
import { apiRequest, errorMessage } from '../lib/api';
import type { ContextsResponse } from '../types';

export function useContexts() {
  const { data, error } = useApi<ContextsResponse>('/api/contexts');
  const [switchError, setSwitchError] = useState<string | null>(null);

  const switchContext = async (name: string) => {
    setSwitchError(null);
    try {
      await apiRequest(`/api/contexts/${encodeURIComponent(name)}`, { method: 'PUT' });
    } catch (err) {
      setSwitchError(errorMessage(err));
      return;
    }
    window.location.reload();
  };

  return { contexts: data, error: switchError ?? error, switchContext };
}
