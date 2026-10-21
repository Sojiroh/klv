import { KubeError } from './errors.js';

export type K8sNameKind = 'namespace' | 'pod' | 'container' | 'deployment' | 'statefulset' | 'daemonset';

// RFC 1123 label (namespace, container) y subdominio (pod y workloads)
const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function assertK8sName(kind: K8sNameKind, value: string): void {
  const isLabel = kind === 'namespace' || kind === 'container';
  const maxLength = isLabel ? 63 : 253;
  const valid = typeof value === 'string'
    && value.length <= maxLength
    && (isLabel ? LABEL : SUBDOMAIN).test(value);

  if (!valid) {
    throw new KubeError(`Nombre de ${kind} inválido: "${value}"`, 400);
  }
}
