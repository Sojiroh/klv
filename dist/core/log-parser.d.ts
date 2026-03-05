export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'UNKNOWN';
export interface ParsedLog {
    raw: string;
    isJson: boolean;
    timestamp?: string;
    level: LogLevel;
    message: string;
    service?: string;
    traceId?: string;
    spanId?: string;
    caller?: string;
    error?: string;
    stackTrace?: string;
    podName?: string;
    extra: Record<string, unknown>;
}
export declare function parseLogLine(line: string, podName?: string): ParsedLog;
export declare function matchesFilter(log: ParsedLog, filter: LogFilter): boolean;
export interface LogFilter {
    level?: LogLevel;
    minLevel?: LogLevel;
    search?: string;
    traceId?: string;
    service?: string;
    excludePatterns?: string[];
}
