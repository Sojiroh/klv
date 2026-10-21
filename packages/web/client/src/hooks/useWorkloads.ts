import { useCallback, useEffect, useState } from 'react';
import { apiRequest, errorMessage } from '../lib/api';
import { rolloutState } from '../lib/rollout';
import { WORKLOAD_KINDS, WORKLOAD_RESOURCES } from '../lib/workloads';
import type { Workload } from '../types';

// Refresh cadence while a rollout is in progress, and while pods are missing outside a rollout
// (scale-ups, crash loops), which can last much longer
const PROGRESSING_POLL_MS = 2000;
const NOT_READY_POLL_MS = 5000;

interface WorkloadsState {
  namespace: string;
  data: Workload[];
  errors: string[];
}

export function useWorkloads(namespace: string | null) {
  const [state, setState] = useState<WorkloadsState | null>(null);
  const [version, setVersion] = useState(0);

  const current = state !== null && state.namespace === namespace ? state : null;
  const data = current?.data ?? null;
  const phases = new Set(data?.map((w) => rolloutState(w).phase));
  const pollMs = phases.has('progressing')
    ? PROGRESSING_POLL_MS
    : phases.has('notReady') ? NOT_READY_POLL_MS : null;

  useEffect(() => {
    if (!namespace) return;
    const controller = new AbortController();
    const ns = encodeURIComponent(namespace);

    void Promise.allSettled(WORKLOAD_KINDS.map((kind) => (
      apiRequest<Workload[]>(`/api/${WORKLOAD_RESOURCES[kind]}/${ns}`, { signal: controller.signal })
    ))).then((results) => {
      if (controller.signal.aborted) return;
      setState((prev) => {
        const previous = prev?.namespace === namespace ? prev.data : [];
        return {
          namespace,
          // A kind that failed to refresh keeps its last known rows; the error is reported
          data: results.flatMap((result, i) => (result.status === 'fulfilled'
            ? result.value
            : previous.filter((w) => w.kind === WORKLOAD_KINDS[i]))),
          errors: results.flatMap((result) => (result.status === 'rejected' ? [errorMessage(result.reason)] : [])),
        };
      });
    });

    return () => controller.abort();
  }, [namespace, version]);

  // Each response schedules the next poll while something is rolling out or not ready
  useEffect(() => {
    if (pollMs === null) return;
    const timer = setTimeout(() => setVersion((v) => v + 1), pollMs);
    return () => clearTimeout(timer);
  }, [pollMs, data]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Shows the server's answer to an action right away and refetches, which discards any in-flight
  // (older) response that would otherwise overwrite it
  const replace = useCallback((workload: Workload) => {
    setState((prev) => prev && prev.namespace === workload.namespace
      ? {
        ...prev,
        data: prev.data.map((w) => (w.kind === workload.kind && w.name === workload.name ? workload : w)),
      }
      : prev);
    setVersion((v) => v + 1);
  }, []);

  return {
    workloads: data,
    loading: namespace !== null && current === null,
    errors: current?.errors ?? [],
    pollMs,
    refresh,
    replace,
  };
}
