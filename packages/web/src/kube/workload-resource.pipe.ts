import { Injectable, NotFoundException, type PipeTransform } from '@nestjs/common';
import type { WorkloadKind } from '@klv/core';

const WORKLOAD_RESOURCES: Readonly<Record<string, WorkloadKind>> = {
  deployments: 'Deployment',
  statefulsets: 'StatefulSet',
  daemonsets: 'DaemonSet',
};

// Recurso de la URL (`deployments`, `statefulsets`, `daemonsets`) -> tipo de workload
@Injectable()
export class WorkloadResourcePipe implements PipeTransform<string, WorkloadKind> {
  transform(resource: string): WorkloadKind {
    if (!Object.hasOwn(WORKLOAD_RESOURCES, resource)) {
      throw new NotFoundException(`Tipo de workload no soportado: "${resource}"`);
    }
    return WORKLOAD_RESOURCES[resource];
  }
}
