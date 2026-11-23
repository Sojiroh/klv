import { Logger } from '@nestjs/common';
import { KubeClient, LEVEL_PRIORITY, parseLogLine } from '@klv/core';
import type { LogOptions, LogStream, ParsedLog, PodInfo, PodWatchEventType } from '@klv/core';
import { parseKubeletMicros } from './history-store';
import type { HistoryStore, LogScope } from './history-store';
import type { CollectorStatus, CollectorStream, CollectorTarget } from './history.types';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
// Un watch que duró más que esto se considera sano: su cierre es rutinario (timeout del apiserver)
const STABLE_WATCH_MS = 30_000;
const FIRST_TAIL_LINES = 1000;
const NOT_STARTED = /waiting to start|PodInitializing|ContainerCreating/;

// Sigue un contenedor con reconexión exponencial (1 s → 60 s, se reinicia al recibir una línea).
// Aplica los filtros del target antes de encolar y descarta las líneas ya guardadas al reanudar
class StreamFollower {
  private state: CollectorStream['state'] = 'waiting';
  private error: string | undefined;
  private lastLineAt: string | undefined;
  private backoff = MIN_BACKOFF_MS;
  private timer: NodeJS.Timeout | undefined;
  private stream: LogStream | undefined;
  private attempt = 0;
  // Mayor timestamp leído por este follower (filtrado o no) y cuántas líneas se leyeron con ese timestamp: al
  // reconectar en el mismo proceso se descartan las anteriores y solo las N primeras de ese instante
  private lastTs: number | null = null;
  private lastTsCount = 0;
  private stopped = false;

  constructor(
    private readonly client: KubeClient,
    private readonly store: HistoryStore,
    private readonly scope: LogScope,
    private readonly target: CollectorTarget,
  ) {}

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.stream?.stop();
    this.stream = undefined;
  }

  status(): CollectorStream {
    return {
      pod: this.scope.pod,
      container: this.scope.container,
      state: this.state,
      ...(this.lastLineAt !== undefined && { lastLineAt: this.lastLineAt }),
      ...(this.error !== undefined && { error: this.error }),
    };
  }

  // true si el target descarta la línea (nivel por debajo de minLevel o mensaje con un patrón de exclude)
  private filtered(log: ParsedLog): boolean {
    const { minLevel, exclude } = this.target;
    if (minLevel !== undefined && log.level !== 'UNKNOWN' && LEVEL_PRIORITY[log.level] < LEVEL_PRIORITY[minLevel]) return true;
    return exclude?.some((pattern) => log.message.includes(pattern)) ?? false;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const attempt = ++this.attempt;
    // Con el proceso en marcha se conoce cuántas líneas del último instante (lastTs) se leyeron: se descartan las
    // anteriores y solo las primeras N de ese instante. Solo si este follower aún no ha leído nada el punto sale de
    // la base de datos (tras un reinicio no se sabe cuántas se leyeron) y se descarta todo lo que tenga ts_us <= storedUs
    const inProcess = this.lastTs !== null;
    const storedUs = inProcess ? null : await this.store.lastTimestampUs(this.scope);
    if (this.stopped || attempt !== this.attempt) return;
    const floorUs = inProcess ? this.lastTs : storedUs;
    const floorCount = inProcess ? this.lastTsCount : null;
    let skippedAtFloor = 0;
    const resume: Pick<LogOptions, 'tailLines' | 'sinceTime'> = floorUs === null
      ? { tailLines: FIRST_TAIL_LINES }
      : { sinceTime: new Date(Math.floor(floorUs / 1_000_000) * 1000).toISOString() };
    let ended = false;

    const end = (state: CollectorStream['state'], error?: string): void => {
      if (ended || this.stopped || attempt !== this.attempt) return;
      ended = true;
      this.stream = undefined;
      this.state = error !== undefined && NOT_STARTED.test(error) ? 'waiting' : state;
      this.error = error;
      const delay = this.backoff;
      this.backoff = Math.min(delay * 2, MAX_BACKOFF_MS);
      this.timer = setTimeout(() => void this.connect(), delay);
    };

    const stream = await this.client.streamLogs(
      { namespace: this.scope.namespace, podName: this.scope.pod, container: this.scope.container, timestamps: true, ...resume },
      {
        onLine: (line) => {
          if (ended || this.stopped || attempt !== this.attempt) return;
          this.backoff = MIN_BACKOFF_MS;
          this.state = 'following';
          this.error = undefined;
          this.lastLineAt = new Date().toISOString();

          const log = parseLogLine(line, this.scope.pod);
          // Las líneas sin prefijo de kubelet válido llevan la hora de llegada y nunca se descartan
          const tsUs = log.k8sTimestamp !== undefined ? parseKubeletMicros(log.k8sTimestamp) : null;
          if (tsUs !== null) {
            if (floorUs !== null) {
              if (tsUs < floorUs) return;
              if (tsUs === floorUs) {
                if (floorCount === null) return;
                if (skippedAtFloor < floorCount) {
                  skippedAtFloor++;
                  return;
                }
              }
            }
            // Toda línea leída cuenta, la filtre el target o no
            if (this.lastTs === null || tsUs > this.lastTs) {
              this.lastTs = tsUs;
              this.lastTsCount = 1;
            } else if (tsUs === this.lastTs) {
              this.lastTsCount++;
            }
          }
          if (this.filtered(log)) return;
          this.store.enqueue(this.scope, log);
        },
        onError: (err) => end('error', err.message),
        onEnd: () => end('waiting'),
      },
    );

    if (ended) return;
    if (this.stopped || attempt !== this.attempt) {
      stream.stop();
      return;
    }
    this.stream = stream;
    this.state = 'following';
    this.error = undefined;
  }
}

// Descubre los pods de un target (list + watch con re-list) y mantiene un StreamFollower por pod × contenedor
export class TargetCollector {
  private readonly logger = new Logger('HistoryCollector');
  private client: KubeClient | undefined;
  private readonly followers = new Map<string, Map<string, StreamFollower>>();
  private stopWatch: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private backoff = MIN_BACKOFF_MS;
  private error: string | undefined;
  private stopped = false;

  constructor(
    readonly target: CollectorTarget,
    private readonly store: HistoryStore,
  ) {}

  start(): void {
    void this.watch();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.stopWatch?.();
    this.stopWatch = undefined;
    for (const pod of [...this.followers.keys()]) this.stopPod(pod);
  }

  status(): CollectorStatus {
    return {
      targetId: this.target.id,
      state: this.error === undefined ? 'running' : 'error',
      ...(this.error !== undefined && { error: this.error }),
      streams: [...this.followers.values()].flatMap((containers) => [...containers.values()].map((f) => f.status())),
    };
  }

  private async watch(): Promise<void> {
    if (this.stopped) return;
    const startedAt = Date.now();
    const seen = new Set<string>();
    let failed = false;

    let client: KubeClient;
    try {
      client = this.client ??= new KubeClient(undefined, this.target.context);
    } catch (err) {
      this.restartWatch(err instanceof Error ? err : new Error(String(err)), startedAt);
      return;
    }

    const stop = await client.watchPods(this.target.namespace, this.target.labelSelector, {
      onEvent: (type, pod) => {
        if (this.stopped) return;
        if (type !== 'DELETED') seen.add(pod.name);
        this.handlePod(type, pod);
      },
      onError: (err) => {
        failed = true;
        if (!this.stopped) this.restartWatch(err, startedAt);
      },
    });

    if (this.stopped) {
      stop();
      return;
    }
    this.stopWatch = stop;
    if (failed) return;

    // Tras un re-list, los pods que ya no existen no generan DELETED
    this.error = undefined;
    for (const pod of [...this.followers.keys()]) {
      if (!seen.has(pod)) this.stopPod(pod);
    }
  }

  private restartWatch(err: Error, startedAt: number): void {
    this.stopWatch?.();
    this.stopWatch = undefined;
    if (Date.now() - startedAt > STABLE_WATCH_MS) {
      this.backoff = MIN_BACKOFF_MS;
    } else {
      this.error = err.message;
      this.logger.warn(`Colector ${this.target.context}/${this.target.namespace}: ${err.message}`);
    }
    const delay = this.backoff;
    this.backoff = Math.min(delay * 2, MAX_BACKOFF_MS);
    this.timer = setTimeout(() => void this.watch(), delay);
  }

  private handlePod(type: PodWatchEventType, pod: PodInfo): void {
    if (type === 'DELETED') {
      this.stopPod(pod.name);
      return;
    }

    const client = this.client;
    if (client === undefined) return;

    const selected = this.target.containers;
    const wanted = selected === undefined || selected.length === 0
      ? pod.containers
      : pod.containers.filter((container) => selected.includes(container));
    let containers = this.followers.get(pod.name);
    if (containers === undefined) {
      containers = new Map();
      this.followers.set(pod.name, containers);
    }

    for (const [container, follower] of containers) {
      if (!wanted.includes(container)) {
        follower.stop();
        containers.delete(container);
      }
    }
    for (const container of wanted) {
      if (containers.has(container)) continue;
      const follower = new StreamFollower(client, this.store, {
        context: this.target.context,
        namespace: this.target.namespace,
        pod: pod.name,
        container,
      }, this.target);
      containers.set(container, follower);
      follower.start();
    }
  }

  private stopPod(pod: string): void {
    for (const follower of this.followers.get(pod)?.values() ?? []) follower.stop();
    this.followers.delete(pod);
  }
}
