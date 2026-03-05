import type { ParsedLog, LogLevel } from '../core/log-parser.js';
export interface FormatOptions {
    showTimestamp: boolean;
    showPodName: boolean;
    showService: boolean;
    showTraceId: boolean;
    showExtra: boolean;
    compact: boolean;
    maxMessageWidth: number;
}
export declare function formatLog(log: ParsedLog, options?: Partial<FormatOptions>): string;
export declare function formatLogSeparator(text: string): string;
export declare function formatStats(counts: Record<LogLevel, number>): string;
