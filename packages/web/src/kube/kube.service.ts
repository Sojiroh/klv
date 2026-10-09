import { Injectable, NotFoundException } from '@nestjs/common';
import { KubeClient, type LogOptions } from '@klv/core';

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

  getDeployments(namespace: string) {
    return this.client.getDeployments(namespace);
  }

  getLogs(options: LogOptions) {
    return this.client.getLogs(options);
  }

  getClient() {
    return this.client;
  }
}
