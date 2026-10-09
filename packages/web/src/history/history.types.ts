import type { ParsedLog, QueryNode } from '@klv/core';

export interface CollectorTarget {
  id: string;
  context: string;
  namespace: string;
  container?: string;
  labelSelector?: string;
  enabled: boolean;
}

export interface CollectorTargetInput {
  id?: string;
  context: string;
  namespace: string;
  container?: string;
  labelSelector?: string;
  enabled: boolean;
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
