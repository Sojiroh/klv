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
export declare class KubeClient {
    private kc;
    private coreApi;
    private appsApi;
    private kubeconfigPath;
    constructor(kubeconfig?: string, context?: string);
    getCurrentContext(): string;
    getContexts(): string[];
    useContext(contextName: string): void;
    getNamespaces(): Promise<string[]>;
    getPods(namespace: string, labelSelector?: string): Promise<PodInfo[]>;
    getDeployments(namespace: string): Promise<string[]>;
    getPodsForDeployment(namespace: string, deploymentName: string): Promise<PodInfo[]>;
    getLogs(options: LogOptions): Promise<string>;
    streamLogs(options: LogOptions, onLine: (line: string, podName: string) => void, onError: (err: Error, podName: string) => void): Promise<() => void>;
    private getAge;
}
