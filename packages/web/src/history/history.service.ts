import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { KubeClient } from '@klv/core';
import { TargetCollector } from './history-collector';
import { loadConfig, normalizeConfig, saveConfig } from './history-config';
import { migrateLegacyHistory } from './history-legacy';
import { queryHistory } from './history-query';
import { HistoryStore, resolveDataDir } from './history-store';
import type {
  CollectorTarget,
  HistoryConfig,
  HistoryQueryResponse,
  HistoryStatus,
} from './history.types';

// Rollover de segmentos cerrados + retención
const MAINTENANCE_INTERVAL_MS = 60 * 1000;

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((item, i) => item === b[i]));
}

function sameCollection(a: CollectorTarget, b: CollectorTarget): boolean {
  return a.context === b.context
    && a.namespace === b.namespace
    && sameList(a.containers, b.containers)
    && a.labelSelector === b.labelSelector
    && a.minLevel === b.minLevel
    && sameList(a.exclude, b.exclude);
}

@Injectable()
export class HistoryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HistoryService.name);
  private readonly dataDir = resolveDataDir();
  private readonly collectors = new Map<string, TargetCollector>();
  private store!: HistoryStore;
  private config!: HistoryConfig;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private maintaining = false;

  async onModuleInit(): Promise<void> {
    await migrateLegacyHistory(this.dataDir);
    this.config = loadConfig(this.dataDir);
    this.store = await HistoryStore.open(this.dataDir);
    for (const target of this.config.targets) this.startCollector(target);

    this.maintenanceTimer = setInterval(() => this.maintain(), MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
    this.maintain();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.maintenanceTimer);
    for (const collector of this.collectors.values()) collector.stop();
    this.collectors.clear();
    await this.store.close();
  }

  getConfig(): HistoryConfig {
    return this.config;
  }

  async setConfig(body: unknown): Promise<HistoryConfig> {
    const next = normalizeConfig(body, new KubeClient().getContexts());
    await saveConfig(this.dataDir, next);
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
      this.maintain();
    }
    return next;
  }

  async getStatus(): Promise<HistoryStatus> {
    return {
      stats: await this.store.stats(),
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

  // Rollover y poda por antigüedad/tamaño según la retención vigente; una pasada a la vez
  private maintain(): void {
    if (this.maintaining) return;
    this.maintaining = true;
    this.store
      .rollover()
      .then(() => this.store.prune(this.config.retention))
      .catch((err: unknown) => {
        this.logger.error(`Error en el mantenimiento del historial: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.maintaining = false;
      });
  }
}
