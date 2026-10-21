import type { Deployment } from '../types';

export type RolloutPhase = 'ready' | 'progressing' | 'unavailable' | 'failed' | 'paused';

export interface RolloutState {
  phase: RolloutPhase;
  detail?: string;
}

// Same checks and order as `kubectl rollout status`, plus `unavailable` for a finished rollout
// that lost replicas afterwards (crashes, evictions), which kubectl would still report as waiting.
export function rolloutState(d: Deployment): RolloutState {
  if (d.paused) return { phase: 'paused', detail: 'Rollout paused' };
  if (d.observedGeneration < d.generation) {
    return { phase: 'progressing', detail: 'Waiting for the controller to observe the change' };
  }
  const progressing = d.conditions.find((c) => c.type === 'Progressing');
  if (progressing?.reason === 'ProgressDeadlineExceeded') {
    return { phase: 'failed', detail: progressing.message ?? 'Progress deadline exceeded' };
  }
  if (d.updated < d.desired) {
    return { phase: 'progressing', detail: `${d.updated} of ${d.desired} replicas updated` };
  }
  if (d.current > d.updated) {
    const old = d.current - d.updated;
    return { phase: 'progressing', detail: `${old} old ${old === 1 ? 'replica' : 'replicas'} pending termination` };
  }
  if (d.available < d.updated) {
    const detail = `${d.available} of ${d.updated} replicas available`;
    return progressing?.reason === 'NewReplicaSetAvailable'
      ? { phase: 'unavailable', detail }
      : { phase: 'progressing', detail };
  }
  return { phase: 'ready' };
}
