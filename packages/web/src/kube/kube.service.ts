import { Injectable } from '@nestjs/common';
import { KubeClient, type PodInfo, type LogOptions } from '@klv/core';

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
    this.client.useContext(name);
    // Recreate client with new context
    this.client = new KubeClient();
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
