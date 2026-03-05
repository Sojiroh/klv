import * as k8s from '@kubernetes/client-node';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PassThrough } from 'stream';
export class KubeClient {
    kc;
    coreApi;
    appsApi;
    kubeconfigPath;
    constructor(kubeconfig, context) {
        this.kc = new k8s.KubeConfig();
        this.kubeconfigPath = kubeconfig ?? join(homedir(), '.kube', 'config');
        if (kubeconfig) {
            this.kc.loadFromFile(kubeconfig);
        }
        else {
            this.kc.loadFromDefault();
        }
        if (context) {
            this.kc.setCurrentContext(context);
        }
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    }
    getCurrentContext() {
        return this.kc.getCurrentContext();
    }
    getContexts() {
        return this.kc.getContexts().map((c) => c.name);
    }
    useContext(contextName) {
        const contexts = this.getContexts();
        if (!contexts.includes(contextName)) {
            throw new Error(`Contexto "${contextName}" no existe. Disponibles: ${contexts.join(', ')}`);
        }
        const content = readFileSync(this.kubeconfigPath, 'utf-8');
        const updated = content.replace(/^current-context:.*$/m, `current-context: ${contextName}`);
        writeFileSync(this.kubeconfigPath, updated, 'utf-8');
    }
    async getNamespaces() {
        try {
            const res = await this.coreApi.listNamespace();
            return (res.items ?? []).map((ns) => ns.metadata?.name ?? '').filter(Boolean);
        }
        catch {
            // Si no tiene permisos para listar namespaces, retornar los del kubeconfig
            const ctx = this.kc.getContextObject(this.kc.getCurrentContext());
            return ctx?.namespace ? [ctx.namespace] : ['default'];
        }
    }
    async getPods(namespace, labelSelector) {
        const res = await this.coreApi.listNamespacedPod({ namespace, labelSelector });
        return (res.items ?? []).map((pod) => ({
            name: pod.metadata?.name ?? '',
            namespace: pod.metadata?.namespace ?? namespace,
            status: pod.status?.phase ?? 'Unknown',
            containers: (pod.spec?.containers ?? []).map((c) => c.name),
            labels: pod.metadata?.labels ?? {},
            age: this.getAge(pod.metadata?.creationTimestamp),
        }));
    }
    async getDeployments(namespace) {
        const res = await this.appsApi.listNamespacedDeployment({ namespace });
        return (res.items ?? []).map((d) => d.metadata?.name ?? '').filter(Boolean);
    }
    async getPodsForDeployment(namespace, deploymentName) {
        const deployment = await this.appsApi.readNamespacedDeployment({
            name: deploymentName,
            namespace,
        });
        const matchLabels = deployment.spec?.selector?.matchLabels;
        if (!matchLabels)
            return [];
        const selector = Object.entries(matchLabels)
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
        return this.getPods(namespace, selector);
    }
    async getLogs(options) {
        const res = await this.coreApi.readNamespacedPodLog({
            name: options.podName,
            namespace: options.namespace,
            container: options.container,
            tailLines: options.tailLines ?? 100,
            sinceSeconds: options.sinceSeconds,
            timestamps: options.timestamps,
        });
        return typeof res === 'string' ? res : String(res);
    }
    async streamLogs(options, onLine, onError) {
        const log = new k8s.Log(this.kc);
        const stream = new PassThrough();
        let buffer = '';
        const abortController = new AbortController();
        try {
            await log.log(options.namespace, options.podName, options.container ?? '', stream, {
                follow: true,
                tailLines: options.tailLines ?? 50,
                timestamps: options.timestamps,
            });
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.trim()) {
                        onLine(line, options.podName);
                    }
                }
            });
            stream.on('error', (err) => {
                onError(err, options.podName);
            });
        }
        catch (err) {
            onError(err, options.podName);
        }
        return () => {
            stream.destroy();
            abortController.abort();
        };
    }
    getAge(timestamp) {
        if (!timestamp)
            return 'Unknown';
        const now = new Date();
        const diff = now.getTime() - new Date(timestamp).getTime();
        const seconds = Math.floor(diff / 1000);
        if (seconds < 60)
            return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60)
            return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24)
            return `${hours}h`;
        const days = Math.floor(hours / 24);
        return `${days}d`;
    }
}
