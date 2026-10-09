import { Injectable } from '@nestjs/common';
import {
  parseLogLine,
  matchesFilter,
  compareLogsByTime,
  type ParsedLog,
  type LogFilter,
  type LogLevel,
} from '@klv/core';
import { KubeService } from '../kube/kube.service';

export interface AggregatedLogs {
  logs: ParsedLog[];
  total: number;
  offset: number;
  limit: number;
  pods: string[];
  failedPods: { pod: string; error: string }[];
}

type PodFailure = { pod: string; error: unknown };
type PodResult = { pod: string; logs: ParsedLog[] } | PodFailure;

@Injectable()
export class LogService {
  constructor(private readonly kubeService: KubeService) {}

  async getParsedLogs(options: {
    namespace: string;
    pod: string;
    container?: string;
    tail?: number;
    since?: number;
    previous?: boolean;
    level?: LogLevel;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: ParsedLog[]; total: number; offset: number; limit: number }> {
    const raw = await this.kubeService.getLogs({
      namespace: options.namespace,
      podName: options.pod,
      container: options.container,
      tailLines: options.tail ?? 100,
      sinceSeconds: options.since,
      previous: options.previous,
      timestamps: true,
    });

    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed = lines.map((line) => parseLogLine(line, options.pod));

    const filter: LogFilter = {};
    if (options.level) filter.minLevel = options.level;
    if (options.search) filter.search = options.search;

    const filtered = parsed.filter((log) => matchesFilter(log, filter));
    const start = options.offset ?? 0;
    const paginated =
      options.limit != null ? filtered.slice(start, start + options.limit) : filtered.slice(start);

    return {
      logs: paginated,
      total: filtered.length,
      offset: start,
      limit: options.limit ?? filtered.length,
    };
  }

  async getAggregatedLogs(options: {
    namespace: string;
    container: string;
    tail?: number;
    since?: number;
    previous?: boolean;
    level?: LogLevel;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<AggregatedLogs> {
    const allPods = await this.kubeService.getPods(options.namespace);
    const matchingPods = allPods.filter((p) =>
      p.containers.includes(options.container),
    );

    if (matchingPods.length === 0) {
      return { logs: [], total: 0, offset: 0, limit: 0, pods: [], failedPods: [] };
    }

    const tailPerPod = options.tail ?? 100;
    const results = await Promise.all(
      matchingPods.map(async (pod): Promise<PodResult> => {
        try {
          const raw = await this.kubeService.getLogs({
            namespace: options.namespace,
            podName: pod.name,
            container: options.container,
            tailLines: tailPerPod,
            sinceSeconds: options.since,
            previous: options.previous,
            timestamps: true,
          });
          const lines = raw.split('\n').filter((l) => l.trim());
          return { pod: pod.name, logs: lines.map((line) => parseLogLine(line, pod.name)) };
        } catch (err) {
          return { pod: pod.name, error: err };
        }
      }),
    );

    const failures = results.filter((r): r is PodFailure => 'error' in r);
    if (failures.length === results.length) throw failures[0].error;

    const failedPods = failures.map((f) => ({
      pod: f.pod,
      error: f.error instanceof Error ? f.error.message : String(f.error),
    }));
    const allParsed = results.flatMap((r) => ('logs' in r ? r.logs : []));
    allParsed.sort(compareLogsByTime);

    const filter: LogFilter = {};
    if (options.level) filter.minLevel = options.level;
    if (options.search) filter.search = options.search;

    const filtered = allParsed.filter((log) => matchesFilter(log, filter));
    const start = options.offset ?? 0;
    const paginated =
      options.limit != null ? filtered.slice(start, start + options.limit) : filtered.slice(start);

    return {
      logs: paginated,
      total: filtered.length,
      offset: start,
      limit: options.limit ?? filtered.length,
      pods: matchingPods.map((p) => p.name),
      failedPods,
    };
  }
}
