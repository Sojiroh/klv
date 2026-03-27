export interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  level: string;
  message: string;
  service?: string;
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

export interface StreamOptions {
  namespace: string;
  pods: string[];
  container?: string;
  filters?: {
    level?: string;
    search?: string;
  };
}
