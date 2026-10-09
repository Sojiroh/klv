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
}

export interface LogOptions {
  namespace: string;
  podName: string;
  container?: string;
  follow?: boolean;
  tailLines?: number;
  sinceSeconds?: number;
  timestamps?: boolean;
}

export interface StreamHandlers {
  onLine: (line: string, podName: string) => void;
  onError: (err: Error, podName: string) => void;
  onEnd?: (podName: string) => void;
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
      return (res.items ?? []).map((pod) => ({
        name: pod.metadata?.name ?? '',
        namespace: pod.metadata?.namespace ?? namespace,
        status: pod.status?.phase ?? 'Unknown',
        containers: (pod.spec?.containers ?? []).map((c) => c.name),
        labels: pod.metadata?.labels ?? {},
        age: this.getAge(pod.metadata?.creationTimestamp),
      }));
    } catch (err) {
      throw toKubeError(err, `Error al obtener pods del namespace "${namespace}"`);
    }
  }

  async getDeployments(namespace: string): Promise<string[]> {
    assertK8sName('namespace', namespace);
    try {
      const res = await this.appsApi.listNamespacedDeployment({ namespace });
      return (res.items ?? []).map((d) => d.metadata?.name ?? '').filter(Boolean);
    } catch (err) {
      throw toKubeError(err, `Error al obtener deployments del namespace "${namespace}"`);
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

  async getLogs(options: LogOptions): Promise<string> {
    assertK8sName('namespace', options.namespace);
    assertK8sName('pod', options.podName);
    if (options.container) assertK8sName('container', options.container);
    try {
      const res = await this.coreApi.readNamespacedPodLog({
        name: options.podName,
        namespace: options.namespace,
        container: options.container,
        tailLines: options.tailLines ?? 100,
        sinceSeconds: options.sinceSeconds,
        timestamps: options.timestamps,
      });
      return typeof res === 'string' ? res : String(res);
    } catch (err) {
      throw toKubeError(err, `Error al obtener logs del pod "${options.podName}"`);
    }
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
          tailLines: options.tailLines ?? 50,
          timestamps: options.timestamps,
        }
      );
      if (!active) controller.abort();
    } catch (err) {
      fail(toKubeError(err, `Error al abrir el stream de logs del pod "${podName}"`));
    }

    return teardown;
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
