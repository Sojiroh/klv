import type { WorkloadKind } from '../types';

export const WORKLOAD_KINDS: WorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet'];

// REST resource of each kind: `/api/<resource>/:namespace` and `/api/<resource>/:namespace/:name/(restart|scale)`
export const WORKLOAD_RESOURCES: Record<WorkloadKind, string> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
};
