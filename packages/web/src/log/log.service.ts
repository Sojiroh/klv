import { Injectable } from '@nestjs/common';
import { parseLogLine, matchesFilter, type ParsedLog, type LogFilter, type LogLevel } from '@klv/core';
import { KubeService } from '../kube/kube.service';

@Injectable()
export class LogService {
  constructor(private readonly kubeService: KubeService) {}

  async getParsedLogs(options: {
    namespace: string;
    pod: string;
    container?: string;
    tail?: number;
    since?: number;
    level?: string;
    search?: string;
  }): Promise<{ logs: ParsedLog[]; total: number }> {
    const raw = await this.kubeService.getLogs({
      namespace: options.namespace,
      podName: options.pod,
      container: options.container,
      tailLines: options.tail ?? 100,
      sinceSeconds: options.since,
      timestamps: true,
    });

    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed = lines.map((line) => parseLogLine(line, options.pod));

    const filter: LogFilter = {};
    if (options.level) filter.minLevel = options.level.toUpperCase() as LogLevel;
    if (options.search) filter.search = options.search;

    const filtered = parsed.filter((log) => matchesFilter(log, filter));

    return { logs: filtered, total: parsed.length };
  }

  async getAggregatedLogs(options: {
    namespace: string;
    container: string;
    tail?: number;
    since?: number;
    level?: string;
    search?: string;
  }): Promise<{ logs: ParsedLog[]; total: number; pods: string[] }> {
    const allPods = await this.kubeService.getPods(options.namespace);
    const matchingPods = allPods.filter((p) =>
      p.containers.includes(options.container),
    );

    if (matchingPods.length === 0) {
      return { logs: [], total: 0, pods: [] };
    }

    const tailPerPod = options.tail ?? 100;
    const results = await Promise.all(
      matchingPods.map(async (pod) => {
        try {
          const raw = await this.kubeService.getLogs({
            namespace: options.namespace,
            podName: pod.name,
            container: options.container,
            tailLines: tailPerPod,
            sinceSeconds: options.since,
            timestamps: true,
          });
          const lines = raw.split('\n').filter((l) => l.trim());
          return lines.map((line) => parseLogLine(line, pod.name));
        } catch {
          return [];
        }
      }),
    );

    const allParsed = results.flat();
    allParsed.sort((a, b) =>
      (a.timestamp ?? '').localeCompare(b.timestamp ?? ''),
    );

    const filter: LogFilter = {};
    if (options.level) filter.minLevel = options.level.toUpperCase() as LogLevel;
    if (options.search) filter.search = options.search;

    const filtered = allParsed.filter((log) => matchesFilter(log, filter));

    return {
      logs: filtered,
      total: allParsed.length,
      pods: matchingPods.map((p) => p.name),
    };
  }
}
