import type { QueryNode } from '@klv/query';

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'UNKNOWN';

export interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  k8sTimestamp?: string;
  level: LogLevel;
  message: string;
  service?: string;
  env?: string;
  version?: string;
  traceId?: string;
  spanId?: string;
  caller?: string;
  podName?: string;
  container?: string;
  namespace?: string;
  context?: string;
  error?: string;
  stackTrace?: string;
  extra: Record<string, unknown>;
}

export interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  restarts: Record<string, number>;
  age: string;
}

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';

export interface WorkloadCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface Workload {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  desired: number;
  current: number;
  ready: number;
  updated: number;
  available: number;
  strategy: string;
  partition: number;
  paused: boolean;
  generation: number;
  observedGeneration: number;
  conditions: WorkloadCondition[];
  restartedAt?: string;
  age: string;
}

export interface FailedPod {
  pod: string;
  error: string;
}

export interface LogsResponse {
  logs: ParsedLog[];
  total: number;
  offset: number;
  limit: number;
  pods?: string[];
  failedPods?: FailedPod[];
  truncated?: boolean;
  truncatedPods?: string[];
}

export interface ContextsResponse {
  contexts: string[];
  current: string;
}

export interface StreamOptions {
  namespace: string;
  pods: string[];
  container?: string;
}

export interface StreamLogEvent {
  streamId: string;
  logs: ParsedLog[];
}

export interface StreamErrorEvent {
  streamId: string;
  podName?: string;
  error: string;
}

export interface StreamEndEvent {
  streamId: string;
  podName: string;
}

export interface StreamNotice {
  kind: 'error' | 'end';
  podName?: string;
  message: string;
}

export interface CollectorTarget {
  id: string;
  context: string;
  namespace: string;
  containers?: string[];
  labelSelector?: string;
  enabled: boolean;
  minLevel?: LogLevel;
  exclude?: string[];
}

export interface CollectorTargetInput {
  id?: string;
  context: string;
  namespace: string;
  containers?: string[];
  labelSelector?: string;
  enabled: boolean;
  minLevel?: LogLevel;
  exclude?: string[];
}

export interface RetentionSettings {
  maxAgeDays: number;
  maxSizeMb: number;
}

export interface HistoryConfig {
  targets: CollectorTarget[];
  retention: RetentionSettings;
}

export interface HistoryConfigInput {
  targets: CollectorTargetInput[];
  retention: RetentionSettings;
}

export interface CollectorStream {
  pod: string;
  container: string;
  state: 'following' | 'waiting' | 'error';
  lastLineAt?: string;
  error?: string;
}

export interface CollectorStatus {
  targetId: string;
  state: 'running' | 'disabled' | 'error';
  error?: string;
  streams: CollectorStream[];
}

export interface HistoryStats {
  rows: number;
  sizeBytes: number;
  oldest?: string;
  newest?: string;
}

export interface HistoryStatus {
  stats: HistoryStats;
  collectors: CollectorStatus[];
  dataPath: string;
}

export interface HistoryQueryRequest {
  context?: string;
  namespace?: string;
  pods?: string[];
  containers?: string[];
  from?: string;
  to?: string;
  query?: QueryNode | null;
  limit?: number;
  before?: string;
}

export interface HistoryLog extends ParsedLog {
  context: string;
  namespace: string;
  podName: string;
  container: string;
  k8sTimestamp: string;
}

export interface HistoryQueryResponse {
  logs: HistoryLog[];
  nextCursor: string | null;
  scanned: number;
  truncated: boolean;
}
