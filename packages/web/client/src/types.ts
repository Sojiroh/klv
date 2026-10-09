export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'UNKNOWN';

export interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  k8sTimestamp?: string;
  level: LogLevel;
  message: string;
  service?: string;
  traceId?: string;
  spanId?: string;
  caller?: string;
  podName?: string;
  error?: string;
  stackTrace?: string;
  extra: Record<string, unknown>;
}

export interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
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
}

export interface ContextsResponse {
  contexts: string[];
  current: string;
}

export interface StreamOptions {
  namespace: string;
  pods: string[];
  container?: string;
  filters?: {
    level?: string;
    search?: string;
    excludePatterns?: string[];
  };
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
