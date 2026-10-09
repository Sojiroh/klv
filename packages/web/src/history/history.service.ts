import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { KubeClient } from '@klv/core';
import { TargetCollector } from './history-collector';
import { normalizeConfig } from './history-config';
import { queryHistory } from './history-query';
import { HistoryStore } from './history-store';
import type {
  CollectorTarget,
  HistoryConfig,
  HistoryQueryResponse,
  HistoryStatus,
} from './history.types';

const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

function sameCollection(a: CollectorTarget, b: CollectorTarget): boolean {
  return a.context === b.context
    && a.namespace === b.namespace
    && a.container === b.container
    && a.labelSelector === b.labelSelector;
}

@Injectable()
export class HistoryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HistoryService.name);
  private readonly collectors = new Map<string, TargetCollector>();
  private store!: HistoryStore;
  private config!: HistoryConfig;
  private pruneTimer: NodeJS.Timeout | undefined;
  private pruning = false;

  onModuleInit(): void {
    this.store = new HistoryStore();
    this.config = this.store.loadConfig();
    for (const target of this.config.targets) this.startCollector(target);

    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
    this.prune();
  }

  onApplicationShutdown(): void {
    clearInterval(this.pruneTimer);
    for (const collector of this.collectors.values()) collector.stop();
    this.collectors.clear();
    this.store.close();
  }

  getConfig(): HistoryConfig {
    return this.config;
  }

  setConfig(body: unknown): HistoryConfig {
    const next = normalizeConfig(body, new KubeClient().getContexts());
    this.store.saveConfig(next);
    const previous = this.config;
    this.config = next;

    for (const [id, collector] of this.collectors) {
      const target = next.targets.find((t) => t.id === id);
      if (target === undefined || !target.enabled || !sameCollection(collector.target, target)) {
        collector.stop();
        this.collectors.delete(id);
      }
    }
    for (const target of next.targets) this.startCollector(target);

    if (previous.retention.maxAgeDays !== next.retention.maxAgeDays || previous.retention.maxSizeMb !== next.retention.maxSizeMb) {
      this.prune();
    }
    return next;
  }

  getStatus(): HistoryStatus {
    return {
      stats: this.store.stats(),
      collectors: this.config.targets.map(
        (target) => this.collectors.get(target.id)?.status() ?? { targetId: target.id, state: 'disabled', streams: [] },
      ),
      dataPath: this.store.path,
    };
  }

  query(body: unknown): Promise<HistoryQueryResponse> {
    return queryHistory(this.store, body);
  }

  async clear(): Promise<{ ok: true }> {
    await this.store.clear();
    return { ok: true };
  }

  private startCollector(target: CollectorTarget): void {
    if (!target.enabled || this.collectors.has(target.id)) return;
    const collector = new TargetCollector(target, this.store);
    this.collectors.set(target.id, collector);
    collector.start();
  }

  // Poda por antigüedad y tamaño según la retención vigente; una sola poda a la vez
  private prune(): void {
    if (this.pruning) return;
    this.pruning = true;
    this.store
      .prune(this.config.retention)
      .catch((err: unknown) => {
        this.logger.error(`Error al podar el historial: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.pruning = false;
      });
  }
}
