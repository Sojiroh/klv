import type { Workload } from '../types';

export type RolloutPhase = 'ready' | 'progressing' | 'notReady' | 'failed' | 'paused';

export interface RolloutState {
  phase: RolloutPhase;
  detail?: string;
}

// Same checks and order as the `kubectl rollout status` viewers of each kind. Where kubectl just keeps
// waiting, pods missing outside a detectable rollout (scale-ups, crash loops, evictions) are `notReady`.
export function rolloutState(w: Workload): RolloutState {
  if (w.paused) return { phase: 'paused' };
  if (w.observedGeneration < w.generation) {
    return { phase: 'progressing', detail: 'Waiting for the controller to observe the change' };
  }

  if (w.kind === 'Deployment') {
    const progressing = w.conditions.find((c) => c.type === 'Progressing');
    if (progressing?.reason === 'ProgressDeadlineExceeded') {
      return { phase: 'failed', detail: progressing.message ?? 'Progress deadline exceeded' };
    }
    if (w.updated < w.desired) {
      return { phase: 'progressing', detail: `${w.updated} of ${w.desired} replicas updated` };
    }
    if (w.current > w.updated) {
      const old = w.current - w.updated;
      return { phase: 'progressing', detail: `${old} old ${old === 1 ? 'replica' : 'replicas'} pending termination` };
    }
    if (w.available < w.updated) {
      const detail = `${w.available} of ${w.updated} replicas available`;
      return progressing?.reason === 'NewReplicaSetAvailable'
        ? { phase: 'notReady', detail }
        : { phase: 'progressing', detail };
    }
    return { phase: 'ready' };
  }

  // kubectl waits for available pods on DaemonSets and for ready pods on StatefulSets
  const up = w.kind === 'DaemonSet' ? w.available : w.ready;
  const upDetail = `${up} of ${w.desired} pods ${w.kind === 'DaemonSet' ? 'available' : 'ready'}`;

  // OnDelete has no rollout: pods pick up template changes only when they are deleted
  if (w.strategy === 'OnDelete') {
    const outdated = w.desired - w.updated;
    const pending = outdated > 0 ? `${outdated} outdated, updated when deleted (OnDelete)` : undefined;
    if (up < w.desired) return { phase: 'notReady', detail: pending ? `${upDetail}; ${pending}` : upDetail };
    return { phase: 'ready', detail: pending };
  }

  // Pods below the StatefulSet partition are never updated
  const target = w.desired - w.partition;
  if (w.updated < target) return { phase: 'progressing', detail: `${w.updated} of ${target} pods updated` };
  if (up < w.desired) return { phase: 'notReady', detail: upDetail };
  return { phase: 'ready' };
}
