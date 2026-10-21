import * as k8s from '@kubernetes/client-node';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { homedir } from 'os';
import { PassThrough } from 'stream';
import { KubeError } from './errors.js';
import { assertK8sName } from './k8s-names.js';

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  labels: Record<string, string>;
  age: string;
  // Nombre de contenedor -> reinicios (solo contenedores con estado)
  restarts: Record<string, number>;
}

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet';

export interface WorkloadCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface WorkloadInfo {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  // Pods deseados y conteos del status (DaemonSet: pods programados en los nodos)
  desired: number;
  current: number;
  ready: number;
  updated: number;
  available: number;
  // Deployment: RollingUpdate | Recreate; StatefulSet y DaemonSet: RollingUpdate | OnDelete
  strategy: string;
  // StatefulSet: los pods con ordinal menor que la partición no se actualizan (0 en los demás tipos)
  partition: number;
  // Solo los deployments se pausan
  paused: boolean;
  // observedGeneration < generation: el controller todavía no procesó el último cambio del spec
  generation: number;
  observedGeneration: number;
  conditions: WorkloadCondition[];
  // Fecha (RFC 3339) del último reinicio hecho con klv, kubectl o Lens
  restartedAt?: string;
  age: string;
}

type AppsWorkload = k8s.V1Deployment | k8s.V1StatefulSet | k8s.V1DaemonSet;

// Misma anotación que `kubectl rollout restart` y Lens
const RESTARTED_AT_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';

// spec.replicas es int32
const MAX_REPLICAS = 2 ** 31 - 1;

// Para mensajes y validación de nombres: "deployment", "statefulset", "daemonset"
function workloadLabel(kind: WorkloadKind): 'deployment' | 'statefulset' | 'daemonset' {
  return kind === 'Deployment' ? 'deployment' : kind === 'StatefulSet' ? 'statefulset' : 'daemonset';
}

export interface LogOptions {
  namespace: string;
  podName: string;
  container?: string;
  follow?: boolean;
  tailLines?: number;
  sinceSeconds?: number;
  // RFC3339; con streamLogs reemplaza a tailLines
  sinceTime?: string;
  previous?: boolean;
  timestamps?: boolean;
}

// Tope de caracteres de líneas por lectura de logs (32 MiB)
export const MAX_LOG_READ_CHARS = 32 * 1024 * 1024;

export interface LogRead {
  // Líneas no vacías, de la más antigua a la más reciente
  lines: string[];
  // true si se descartaron líneas antiguas por superar el tope
  truncated: boolean;
}

// Ventana de las líneas más recientes que caben en maxChars; los saltos de línea no cuentan
class LogWindow {
  private lines: string[] = [];
  private head = 0;
  private total = 0;
  private partial = '';
  private skipping = false;
  private truncated = false;

  constructor(private readonly maxChars: number) {}

  push(chunk: string): void {
    let start = 0;
    if (this.skipping) {
      const nl = chunk.indexOf('\n');
      if (nl === -1) return;
      this.skipping = false;
      start = nl + 1;
    }
    let nl = chunk.indexOf('\n', start);
    while (nl !== -1) {
      this.addLine(this.partial + chunk.slice(start, nl));
      this.partial = '';
      start = nl + 1;
      nl = chunk.indexOf('\n', start);
    }
    if (start < chunk.length) {
      this.partial += chunk.slice(start);
      if (this.partial.length > this.maxChars) {
        // Línea más larga que el tope: se descarta hasta el siguiente salto de línea
        this.partial = '';
        this.skipping = true;
        this.truncated = true;
      }
    }
  }

  finish(): LogRead {
    if (this.partial) this.addLine(this.partial);
    this.partial = '';
    return { lines: this.lines.slice(this.head), truncated: this.truncated };
  }

  private addLine(line: string): void {
    if (!line.trim()) return;
    if (line.length > this.maxChars) {
      this.truncated = true;
      return;
    }
    this.lines.push(line);
    this.total += line.length;
    while (this.total > this.maxChars) {
      this.total -= this.lines[this.head].length;
      this.lines[this.head++] = '';
      this.truncated = true;
    }
    // Compacta de vez en cuando para no retener huecos y evitar desplazamientos O(n²)
    if (this.head > 1024 && this.head * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
  }
}

export interface StreamHandlers {
  onLine: (line: string, podName: string) => void;
  onError: (err: Error, podName: string) => void;
  onEnd?: (podName: string) => void;
}

export type PodWatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED';

export interface PodWatchHandlers {
  onEvent: (type: PodWatchEventType, pod: PodInfo) => void;
  // Se invoca una sola vez: ante un error o al cerrarse el watch
  onError: (err: Error) => void;
}

// Mensaje legible del Status de Kubernetes presente en el cuerpo de la respuesta
function statusMessage(body: unknown): string | undefined {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  const message = (parsed as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message ? message : undefined;
}

function toKubeError(err: unknown, action: string): KubeError {
  if (err instanceof KubeError) return err;
  if (err instanceof k8s.ApiException) {
    const detail = statusMessage(err.body) ?? `respuesta HTTP ${err.code}`;
    return new KubeError(`${action}: ${detail}`, err.code);
  }
  return new KubeError(`${action}: ${err instanceof Error ? err.message : String(err)}`);
}

function buildSelector(selector?: k8s.V1LabelSelector): string {
  const parts = Object.entries(selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);

  for (const { key, operator, values } of selector?.matchExpressions ?? []) {
    const list = (values ?? []).join(',');
    switch (operator) {
      case 'In':
        parts.push(`${key} in (${list})`);
        break;
      case 'NotIn':
        parts.push(`${key} notin (${list})`);
        break;
      case 'Exists':
        parts.push(key);
        break;
      case 'DoesNotExist':
        parts.push(`!${key}`);
        break;
      default:
        throw new KubeError(`Operador de selector no soportado: "${operator}"`, 400);
    }
  }

  return parts.join(',');
}

// Valor de current-context seguro en YAML: texto plano si es simple, entre comillas en otro caso
function yamlScalar(value: string): string {
  return /^\w[\w.@/-]*(:[\w.@/-]+)*$/.test(value) ? value : JSON.stringify(value);
}

export class KubeClient {
  private kc: k8s.KubeConfig;
  private coreApi!: k8s.CoreV1Api;
  private appsApi!: k8s.AppsV1Api;
  // Archivo del que se cargó la configuración (undefined con configuración in-cluster)
  private kubeconfigPath: string | undefined;

  constructor(kubeconfig?: string, context?: string) {
    this.kc = new k8s.KubeConfig();

    if (kubeconfig) {
      if (!existsSync(kubeconfig)) {
        throw new Error(`No se encontró el archivo kubeconfig en: ${kubeconfig}`);
      }
      this.kubeconfigPath = kubeconfig;
      this.kc.loadFromFile(kubeconfig);
    } else {
      this.kubeconfigPath = KubeClient.findDefaultKubeconfig();
      // Como kubectl: los archivos inexistentes de KUBECONFIG se ignoran (client-node fallaría con ENOENT)
      // y el primer archivo que define current-context gana
      const envFiles = (process.env.KUBECONFIG ?? '')
        .split(delimiter)
        .filter((file) => file && existsSync(file));
      if (envFiles.length > 0) {
        this.kc.loadFromFile(envFiles[0]);
        for (const file of envFiles.slice(1)) {
          const extra = new k8s.KubeConfig();
          extra.loadFromFile(file);
          this.kc.mergeConfig(extra, true);
        }
      } else if (this.kubeconfigPath !== undefined) {
        this.kc.loadFromFile(this.kubeconfigPath);
      } else if (process.env.KUBERNETES_SERVICE_HOST) {
        this.kc.loadFromCluster();
      } else {
        throw new Error(
          'No se encontró ninguna configuración de Kubernetes: defina KUBECONFIG, cree ~/.kube/config o indique --kubeconfig'
        );
      }
    }

    if (context) {
      this.assertContextExists(context);
      this.kc.setCurrentContext(context);
    }

    this.createApiClients();
  }

  // Primer archivo existente de KUBECONFIG, o ~/.kube/config si KUBECONFIG no está definido
  private static findDefaultKubeconfig(): string | undefined {
    const env = process.env.KUBECONFIG;
    if (env) {
      return env.split(delimiter).find((file) => file && existsSync(file));
    }
    const homeConfig = join(homedir(), '.kube', 'config');
    return existsSync(homeConfig) ? homeConfig : undefined;
  }

  private createApiClients(): void {
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
  }

  private assertContextExists(contextName: string): void {
    const contexts = this.getContexts();
    if (!contexts.includes(contextName)) {
      throw new KubeError(`Contexto "${contextName}" no existe. Disponibles: ${contexts.join(', ')}`, 404);
    }
  }

  getCurrentContext(): string {
    return this.kc.getCurrentContext();
  }

  getContexts(): string[] {
    return this.kc.getContexts().map((c) => c.name);
  }

  // Cambia el contexto activo de forma persistente (archivo kubeconfig) y en esta instancia
  useContext(contextName: string): void {
    this.assertContextExists(contextName);

    const path = this.kubeconfigPath;
    if (!path) {
      throw new Error('No hay un archivo kubeconfig que modificar (configuración in-cluster)');
    }

    try {
      const content = readFileSync(path, 'utf-8');
      const line = `current-context: ${yamlScalar(contextName)}`;
      const pattern = /^current-context:.*$/m;
      const updated = pattern.test(content)
        ? content.replace(pattern, () => line)
        : `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}${line}\n`;
      writeFileSync(path, updated, 'utf-8');
    } catch (err) {
      throw new Error(`Error al modificar kubeconfig: ${(err as Error).message}`);
    }

    this.kc.setCurrentContext(contextName);
    this.createApiClients();
  }

  async getNamespaces(): Promise<string[]> {
    try {
      const res = await this.coreApi.listNamespace();
      return (res.items ?? []).map((ns) => ns.metadata?.name ?? '').filter(Boolean);
    } catch (err) {
      // Sin permiso para listar namespaces, usar el del contexto
      if (err instanceof k8s.ApiException && err.code === 403) {
        const ctx = this.kc.getContextObject(this.kc.getCurrentContext());
        return ctx?.namespace ? [ctx.namespace] : ['default'];
      }
      throw toKubeError(err, 'Error al obtener namespaces');
    }
  }

  async getPods(namespace: string, labelSelector?: string): Promise<PodInfo[]> {
    assertK8sName('namespace', namespace);
    try {
      const res = await this.coreApi.listNamespacedPod({ namespace, labelSelector });
      return (res.items ?? []).map((pod) => this.toPodInfo(pod, namespace));
    } catch (err) {
      throw toKubeError(err, `Error al obtener pods del namespace "${namespace}"`);
    }
  }

  async getWorkloads(kind: WorkloadKind, namespace: string): Promise<WorkloadInfo[]> {
    assertK8sName('namespace', namespace);
    try {
      const items = await this.listWorkloads(kind, namespace);
      return items.map((workload) => this.toWorkloadInfo(kind, workload, namespace));
    } catch (err) {
      throw toKubeError(err, `Error al obtener ${workloadLabel(kind)}s del namespace "${namespace}"`);
    }
  }

  // Como `kubectl rollout restart`: cambia una anotación del template y el controller reemplaza los pods con
  // su estrategia (con OnDelete, solo cuando se borran). Igual que kubectl, rechaza los deployments pausados.
  async restartWorkload(kind: WorkloadKind, namespace: string, name: string): Promise<WorkloadInfo> {
    assertK8sName('namespace', namespace);
    assertK8sName(workloadLabel(kind), name);
    const action = `Error al reiniciar el ${workloadLabel(kind)} "${name}"`;
    try {
      if (kind === 'Deployment') {
        const deployment = await this.appsApi.readNamespacedDeployment({ name, namespace });
        if (deployment.spec?.paused) {
          throw new KubeError(`${action}: está pausado, reanude el rollout primero`, 409);
        }
      }
      const restartedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const request = {
        name,
        namespace,
        fieldManager: 'klv',
        body: { spec: { template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: restartedAt } } } } },
      };
      const options = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.StrategicMergePatch);
      const patched = kind === 'Deployment'
        ? await this.appsApi.patchNamespacedDeployment(request, options)
        : kind === 'StatefulSet'
          ? await this.appsApi.patchNamespacedStatefulSet(request, options)
          : await this.appsApi.patchNamespacedDaemonSet(request, options);
      return this.toWorkloadInfo(kind, patched, namespace);
    } catch (err) {
      throw toKubeError(err, action);
    }
  }

  // Como `kubectl scale`: merge patch de spec.replicas en el subrecurso scale. Los daemonsets no se escalan.
  async scaleWorkload(kind: WorkloadKind, namespace: string, name: string, replicas: number): Promise<WorkloadInfo> {
    assertK8sName('namespace', namespace);
    assertK8sName(workloadLabel(kind), name);
    if (kind === 'DaemonSet') {
      throw new KubeError('Los daemonsets no se escalan: ejecutan un pod por nodo', 400);
    }
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > MAX_REPLICAS) {
      throw new KubeError(`Número de réplicas inválido: ${replicas}`, 400);
    }
    const action = `Error al escalar el ${workloadLabel(kind)} "${name}"`;
    try {
      const request = { name, namespace, fieldManager: 'klv', body: { spec: { replicas } } };
      const options = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch);
      if (kind === 'Deployment') {
        await this.appsApi.patchNamespacedDeploymentScale(request, options);
      } else {
        await this.appsApi.patchNamespacedStatefulSetScale(request, options);
      }
      return this.toWorkloadInfo(kind, await this.readWorkload(kind, namespace, name), namespace);
    } catch (err) {
      throw toKubeError(err, action);
    }
  }

  // Como `kubectl delete pod`: respeta el período de gracia del pod; su controller (si tiene) crea otro
  async deletePod(namespace: string, name: string): Promise<void> {
    assertK8sName('namespace', namespace);
    assertK8sName('pod', name);
    try {
      await this.coreApi.deleteNamespacedPod({ name, namespace });
    } catch (err) {
      throw toKubeError(err, `Error al borrar el pod "${name}"`);
    }
  }

  async getPodsForDeployment(namespace: string, deploymentName: string): Promise<PodInfo[]> {
    assertK8sName('namespace', namespace);
    assertK8sName('deployment', deploymentName);
    try {
      const deployment = await this.appsApi.readNamespacedDeployment({
        name: deploymentName,
        namespace,
      });
      const selector = buildSelector(deployment.spec?.selector);
      if (!selector) return [];

      return await this.getPods(namespace, selector);
    } catch (err) {
      throw toKubeError(err, `Error al obtener pods del deployment "${deploymentName}"`);
    }
  }

  // Lee solo las líneas más recientes que quepan en maxChars (streaming, sin materializar el cuerpo completo)
  async getLogs(options: LogOptions, maxChars: number = MAX_LOG_READ_CHARS): Promise<LogRead> {
    assertK8sName('namespace', options.namespace);
    assertK8sName('pod', options.podName);
    if (options.container) assertK8sName('container', options.container);
    try {
      const stream = new PassThrough();
      stream.setEncoding('utf8');
      const window = new LogWindow(maxChars);
      const finished = new Promise<LogRead>((resolve, reject) => {
        stream.on('data', (chunk: string) => window.push(chunk));
        stream.on('end', () => resolve(window.finish()));
        stream.on('error', reject);
        // Log.log hace body.pipe(stream), que no propaga los errores del origen
        stream.on('pipe', (source) => source.on('error', reject));
      });
      await new k8s.Log(this.kc).log(
        encodeURIComponent(options.namespace),
        encodeURIComponent(options.podName),
        options.container ?? '',
        stream,
        {
          // Con sinceTime solo se limita con tailLines si se indicó expresamente
          tailLines: options.tailLines ?? (options.sinceTime ? undefined : 100),
          sinceSeconds: options.sinceSeconds,
          sinceTime: options.sinceTime,
          previous: options.previous,
          timestamps: options.timestamps,
        }
      );
      return await finished;
    } catch (err) {
      throw toKubeError(err, `Error al obtener logs del pod "${options.podName}"`);
    }
  }

  // Lista los pods (ADDED por cada uno) y observa cambios desde esa versión. Nunca rechaza: los fallos
  // y el cierre del watch van a onError una sola vez. El cleanup devuelto aborta el watch y silencia los handlers.
  async watchPods(
    namespace: string,
    labelSelector: string | undefined,
    handlers: PodWatchHandlers
  ): Promise<() => void> {
    let controller: AbortController | undefined;
    let active = true;

    const teardown = (): void => {
      active = false;
      controller?.abort();
    };

    const fail = (err: Error): void => {
      if (!active) return;
      teardown();
      handlers.onError(err);
    };

    try {
      assertK8sName('namespace', namespace);
      const list = await this.coreApi.listNamespacedPod({ namespace, labelSelector });
      if (!active) return teardown;
      for (const pod of list.items ?? []) {
        handlers.onEvent('ADDED', this.toPodInfo(pod, namespace));
        if (!active) return teardown;
      }

      controller = await new k8s.Watch(this.kc).watch(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
        { labelSelector, resourceVersion: list.metadata?.resourceVersion },
        (phase, object) => {
          if (!active) return;
          if (phase === 'ADDED' || phase === 'MODIFIED' || phase === 'DELETED') {
            handlers.onEvent(phase, this.toPodInfo(object as k8s.V1Pod, namespace));
          } else if (phase === 'ERROR') {
            const detail = statusMessage(object) ?? 'error desconocido';
            fail(new KubeError(`Error en el watch de pods del namespace "${namespace}": ${detail}`));
          }
        },
        (err) => {
          fail(
            err
              ? toKubeError(err, `Error en el watch de pods del namespace "${namespace}"`)
              : new KubeError(`El watch de pods del namespace "${namespace}" se cerró`)
          );
        }
      );
      if (!active) controller.abort();
    } catch (err) {
      fail(toKubeError(err, `Error al observar pods del namespace "${namespace}"`));
    }

    return teardown;
  }

  // Nunca rechaza: los fallos van a onError. El cleanup devuelto aborta la petición HTTP y silencia los handlers.
  async streamLogs(options: LogOptions, handlers: StreamHandlers): Promise<() => void> {
    const { podName } = options;
    const stream = new PassThrough();
    let controller: AbortController | undefined;
    let active = true;
    let buffer = '';

    const teardown = (): void => {
      active = false;
      stream.destroy();
      controller?.abort();
    };

    const emitLine = (line: string): void => {
      if (line.trim()) handlers.onLine(line, podName);
    };

    const fail = (err: Error): void => {
      if (!active) return;
      teardown();
      handlers.onError(err, podName);
    };

    stream.setEncoding('utf8');

    stream.on('data', (chunk: string) => {
      if (!active) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!active) return;
        emitLine(line);
      }
    });

    stream.on('end', () => {
      if (!active) return;
      emitLine(buffer);
      buffer = '';
      if (!active) return;
      teardown();
      handlers.onEnd?.(podName);
    });

    stream.on('error', fail);

    // Log.log hace body.pipe(stream), que no propaga los errores del origen: escucharlos directamente
    stream.on('pipe', (source) => {
      source.on('error', fail);
    });

    try {
      assertK8sName('namespace', options.namespace);
      assertK8sName('pod', options.podName);
      if (options.container) assertK8sName('container', options.container);

      const log = new k8s.Log(this.kc);
      controller = await log.log(
        encodeURIComponent(options.namespace),
        encodeURIComponent(options.podName),
        options.container ?? '',
        stream,
        {
          follow: true,
          tailLines: options.sinceTime ? undefined : (options.tailLines ?? 50),
          sinceTime: options.sinceTime,
          timestamps: options.timestamps,
        }
      );
      if (!active) controller.abort();
    } catch (err) {
      fail(toKubeError(err, `Error al abrir el stream de logs del pod "${podName}"`));
    }

    return teardown;
  }

  // Mismos datos para listados y eventos de watch
  private toPodInfo(pod: k8s.V1Pod, namespace: string): PodInfo {
    const restarts: Record<string, number> = {};
    for (const status of pod.status?.containerStatuses ?? []) {
      restarts[status.name] = status.restartCount;
    }
    return {
      name: pod.metadata?.name ?? '',
      namespace: pod.metadata?.namespace ?? namespace,
      // Igual que kubectl: un pod con deletionTimestamp está terminando, aunque su fase siga siendo Running
      status: pod.metadata?.deletionTimestamp ? 'Terminating' : (pod.status?.phase ?? 'Unknown'),
      containers: (pod.spec?.containers ?? []).map((c) => c.name),
      labels: pod.metadata?.labels ?? {},
      age: this.getAge(pod.metadata?.creationTimestamp),
      restarts,
    };
  }

  private async listWorkloads(kind: WorkloadKind, namespace: string): Promise<AppsWorkload[]> {
    switch (kind) {
      case 'Deployment':
        return (await this.appsApi.listNamespacedDeployment({ namespace })).items ?? [];
      case 'StatefulSet':
        return (await this.appsApi.listNamespacedStatefulSet({ namespace })).items ?? [];
      case 'DaemonSet':
        return (await this.appsApi.listNamespacedDaemonSet({ namespace })).items ?? [];
    }
  }

  private readWorkload(kind: WorkloadKind, namespace: string, name: string): Promise<AppsWorkload> {
    switch (kind) {
      case 'Deployment':
        return this.appsApi.readNamespacedDeployment({ name, namespace });
      case 'StatefulSet':
        return this.appsApi.readNamespacedStatefulSet({ name, namespace });
      case 'DaemonSet':
        return this.appsApi.readNamespacedDaemonSet({ name, namespace });
    }
  }

  private toWorkloadInfo(kind: WorkloadKind, workload: AppsWorkload, namespace: string): WorkloadInfo {
    const { metadata } = workload;
    const conditions: WorkloadCondition[] = workload.status?.conditions ?? [];
    return {
      kind,
      name: metadata?.name ?? '',
      namespace: metadata?.namespace ?? namespace,
      ...this.workloadCounts(kind, workload),
      generation: metadata?.generation ?? 0,
      observedGeneration: workload.status?.observedGeneration ?? 0,
      conditions: conditions.map(({ type, status, reason, message }) => ({ type, status, reason, message })),
      restartedAt: workload.spec?.template?.metadata?.annotations?.[RESTARTED_AT_ANNOTATION],
      age: this.getAge(metadata?.creationTimestamp),
    };
  }

  private workloadCounts(
    kind: WorkloadKind,
    workload: AppsWorkload,
  ): Pick<WorkloadInfo, 'desired' | 'current' | 'ready' | 'updated' | 'available' | 'strategy' | 'partition' | 'paused'> {
    switch (kind) {
      case 'Deployment': {
        const { spec, status } = workload as k8s.V1Deployment;
        return {
          desired: spec?.replicas ?? 1,
          current: status?.replicas ?? 0,
          ready: status?.readyReplicas ?? 0,
          updated: status?.updatedReplicas ?? 0,
          available: status?.availableReplicas ?? 0,
          strategy: spec?.strategy?.type ?? 'RollingUpdate',
          partition: 0,
          paused: spec?.paused ?? false,
        };
      }
      case 'StatefulSet': {
        const { spec, status } = workload as k8s.V1StatefulSet;
        return {
          desired: spec?.replicas ?? 1,
          current: status?.replicas ?? 0,
          ready: status?.readyReplicas ?? 0,
          updated: status?.updatedReplicas ?? 0,
          available: status?.availableReplicas ?? 0,
          strategy: spec?.updateStrategy?.type ?? 'RollingUpdate',
          partition: spec?.updateStrategy?.rollingUpdate?.partition ?? 0,
          paused: false,
        };
      }
      case 'DaemonSet': {
        const { spec, status } = workload as k8s.V1DaemonSet;
        return {
          desired: status?.desiredNumberScheduled ?? 0,
          current: status?.currentNumberScheduled ?? 0,
          ready: status?.numberReady ?? 0,
          updated: status?.updatedNumberScheduled ?? 0,
          available: status?.numberAvailable ?? 0,
          strategy: spec?.updateStrategy?.type ?? 'RollingUpdate',
          partition: 0,
          paused: false,
        };
      }
    }
  }

  private getAge(timestamp?: Date): string {
    if (!timestamp) return 'Unknown';
    const now = new Date();
    const diff = now.getTime() - new Date(timestamp).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }
}
