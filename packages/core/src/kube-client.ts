import * as k8s from '@kubernetes/client-node';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PassThrough } from 'stream';

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

export class KubeClient {
  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
  private kubeconfigPath: string;

  constructor(kubeconfig?: string, context?: string) {
    this.kc = new k8s.KubeConfig();
    this.kubeconfigPath = kubeconfig ?? join(homedir(), '.kube', 'config');

    if (!existsSync(this.kubeconfigPath)) {
      throw new Error(`No se encontró el archivo kubeconfig en: ${this.kubeconfigPath}`);
    }

    if (kubeconfig) {
      this.kc.loadFromFile(kubeconfig);
    } else {
      this.kc.loadFromDefault();
    }

    if (context) {
      this.kc.setCurrentContext(context);
    }

    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
  }

  getCurrentContext(): string {
    return this.kc.getCurrentContext();
  }

  getContexts(): string[] {
    return this.kc.getContexts().map((c) => c.name);
  }

  useContext(contextName: string): void {
    const contexts = this.getContexts();
    if (!contexts.includes(contextName)) {
      throw new Error(`Contexto "${contextName}" no existe. Disponibles: ${contexts.join(', ')}`);
    }

    try {
      const content = readFileSync(this.kubeconfigPath, 'utf-8');
      const updated = content.replace(/^current-context:.*$/m, `current-context: ${contextName}`);
      writeFileSync(this.kubeconfigPath, updated, 'utf-8');
    } catch (err) {
      throw new Error(`Error al modificar kubeconfig: ${(err as Error).message}`);
    }
  }

  async getNamespaces(): Promise<string[]> {
    try {
      const res = await this.coreApi.listNamespace();
      return (res.items ?? []).map((ns) => ns.metadata?.name ?? '').filter(Boolean);
    } catch {
      // Si no tiene permisos para listar namespaces, retornar los del kubeconfig
      const ctx = this.kc.getContextObject(this.kc.getCurrentContext());
      return ctx?.namespace ? [ctx.namespace] : ['default'];
    }
  }

  async getPods(namespace: string, labelSelector?: string): Promise<PodInfo[]> {
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
      throw new Error(`Error al obtener pods del namespace "${namespace}": ${(err as Error).message}`);
    }
  }

  async getDeployments(namespace: string): Promise<string[]> {
    try {
      const res = await this.appsApi.listNamespacedDeployment({ namespace });
      return (res.items ?? []).map((d) => d.metadata?.name ?? '').filter(Boolean);
    } catch (err) {
      throw new Error(`Error al obtener deployments del namespace "${namespace}": ${(err as Error).message}`);
    }
  }

  async getPodsForDeployment(namespace: string, deploymentName: string): Promise<PodInfo[]> {
    try {
      const deployment = await this.appsApi.readNamespacedDeployment({
        name: deploymentName,
        namespace,
      });
      const matchLabels = deployment.spec?.selector?.matchLabels;
      if (!matchLabels) return [];

      const selector = Object.entries(matchLabels)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');

      return this.getPods(namespace, selector);
    } catch (err) {
      throw new Error(`Error al obtener pods del deployment "${deploymentName}": ${(err as Error).message}`);
    }
  }

  async getLogs(options: LogOptions): Promise<string> {
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
      throw new Error(`Error al obtener logs del pod "${options.podName}": ${(err as Error).message}`);
    }
  }

  async streamLogs(
    options: LogOptions,
    onLine: (line: string, podName: string) => void,
    onError: (err: Error, podName: string) => void
  ): Promise<() => void> {
    const log = new k8s.Log(this.kc);
    const stream = new PassThrough();

    let buffer = '';
    const abortController = new AbortController();

    try {
      await log.log(
        options.namespace,
        options.podName,
        options.container ?? '',
        stream,
        {
          follow: true,
          tailLines: options.tailLines ?? 50,
          timestamps: options.timestamps,
        }
      );

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            onLine(line, options.podName);
          }
        }
      });

      stream.on('error', (err: Error) => {
        onError(err, options.podName);
      });
    } catch (err) {
      onError(err as Error, options.podName);
    }

    return () => {
      stream.destroy();
      abortController.abort();
    };
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
