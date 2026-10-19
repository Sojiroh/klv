import { Injectable, NotFoundException } from '@nestjs/common';
import { assertK8sName, KubeClient, type LogOptions } from '@klv/core';

@Injectable()
export class KubeService {
  private client: KubeClient;

  constructor() {
    this.client = new KubeClient();
  }

  getContexts() {
    return {
      contexts: this.client.getContexts(),
      current: this.client.getCurrentContext(),
    };
  }

  useContext(name: string) {
    if (!this.client.getContexts().includes(name)) {
      throw new NotFoundException(`Contexto "${name}" no existe`);
    }
    // Solo cambia el cliente en memoria; no modifica el kubeconfig
    this.client = new KubeClient(undefined, name);
    return { current: this.client.getCurrentContext() };
  }

  getNamespaces() {
    return this.client.getNamespaces();
  }

  getPods(namespace: string, label?: string) {
    return this.client.getPods(namespace, label);
  }

  async getContainers(namespace: string, context?: string, label?: string): Promise<string[]> {
    assertK8sName('namespace', namespace);
    let client = this.client;
    if (context !== undefined && context !== '' && context !== this.client.getCurrentContext()) {
      if (!this.client.getContexts().includes(context)) {
        throw new NotFoundException(`Contexto "${context}" no existe`);
      }
      client = new KubeClient(undefined, context);
    }
    const pods = await client.getPods(namespace, label);
    const names = new Set<string>();
    for (const pod of pods) for (const name of pod.containers) names.add(name);
    return [...names].sort();
  }

  getDeployments(namespace: string) {
    return this.client.getDeployments(namespace);
  }

  getLogs(options: LogOptions, maxChars?: number) {
    return this.client.getLogs(options, maxChars);
  }

  getClient() {
    return this.client;
  }
}
