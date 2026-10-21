import { useCallback, useEffect, useState } from 'react';
import { apiRequest, errorMessage } from '../lib/api';
import { rolloutState } from '../lib/rollout';
import type { Deployment } from '../types';

// Refresh cadence while at least one deployment is rolling out
const ROLLOUT_POLL_MS = 2000;

interface DeploymentsState {
  namespace: string;
  data: Deployment[] | null;
  error: string | null;
}

export function useDeployments(namespace: string | null) {
  const [state, setState] = useState<DeploymentsState | null>(null);
  const [version, setVersion] = useState(0);

  const current = state !== null && state.namespace === namespace ? state : null;
  const data = current?.data ?? null;
  const rolling = data?.some((d) => rolloutState(d).phase === 'progressing') ?? false;

  useEffect(() => {
    if (!namespace) return;
    const controller = new AbortController();

    apiRequest<Deployment[]>(`/api/deployments/${encodeURIComponent(namespace)}`, { signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) setState({ namespace, data: list, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // A failed refresh keeps the last list on screen
        setState((prev) => ({
          namespace,
          data: prev?.namespace === namespace ? prev.data : null,
          error: errorMessage(err),
        }));
      });

    return () => controller.abort();
  }, [namespace, version]);

  // Each response schedules the next poll until no rollout is in progress
  useEffect(() => {
    if (!rolling) return;
    const timer = setTimeout(() => setVersion((v) => v + 1), ROLLOUT_POLL_MS);
    return () => clearTimeout(timer);
  }, [rolling, data]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Shows the server's answer to an action right away and refetches, which discards any in-flight
  // (older) response that would otherwise overwrite it
  const replace = useCallback((deployment: Deployment) => {
    setState((prev) => prev && prev.namespace === deployment.namespace && prev.data
      ? { ...prev, data: prev.data.map((d) => (d.name === deployment.name ? deployment : d)) }
      : prev);
    setVersion((v) => v + 1);
  }, []);

  return {
    deployments: data,
    loading: namespace !== null && current === null,
    error: current?.error ?? null,
    rolling,
    refresh,
    replace,
  };
}
