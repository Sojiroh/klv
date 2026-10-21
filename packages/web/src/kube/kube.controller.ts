import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { WorkloadKind } from '@klv/core';
import { JsonContentTypeGuard } from '../json-content-type.guard';
import { KubeService } from './kube.service';
import { WorkloadResourcePipe } from './workload-resource.pipe';

@Controller()
export class KubeController {
  constructor(private readonly kubeService: KubeService) {}

  @Get('contexts')
  getContexts() {
    return this.kubeService.getContexts();
  }

  @Put('contexts/:name')
  useContext(@Param('name') name: string) {
    return this.kubeService.useContext(name);
  }

  @Get('namespaces')
  getNamespaces() {
    return this.kubeService.getNamespaces();
  }

  @Get('pods/:namespace')
  getPods(
    @Param('namespace') namespace: string,
    @Query('label') label?: string,
  ) {
    return this.kubeService.getPods(namespace, label);
  }

  @Get('containers/:namespace')
  getContainers(
    @Param('namespace') namespace: string,
    @Query('context') context?: string,
    @Query('label') label?: string,
  ) {
    return this.kubeService.getContainers(namespace, context, label);
  }

  @Delete('pods/:namespace/:name')
  @HttpCode(204)
  deletePod(@Param('namespace') namespace: string, @Param('name') name: string) {
    return this.kubeService.deletePod(namespace, name);
  }

  @Get('deployments/:namespace')
  getDeployments(@Param('namespace') namespace: string) {
    return this.kubeService.getWorkloads('Deployment', namespace);
  }

  @Get('statefulsets/:namespace')
  getStatefulSets(@Param('namespace') namespace: string) {
    return this.kubeService.getWorkloads('StatefulSet', namespace);
  }

  @Get('daemonsets/:namespace')
  getDaemonSets(@Param('namespace') namespace: string) {
    return this.kubeService.getWorkloads('DaemonSet', namespace);
  }

  @Post(':resource/:namespace/:name/restart')
  @HttpCode(200)
  @UseGuards(JsonContentTypeGuard)
  restartWorkload(
    @Param('resource', WorkloadResourcePipe) kind: WorkloadKind,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ) {
    return this.kubeService.restartWorkload(kind, namespace, name);
  }

  @Post(':resource/:namespace/:name/scale')
  @HttpCode(200)
  @UseGuards(JsonContentTypeGuard)
  scaleWorkload(
    @Param('resource', WorkloadResourcePipe) kind: WorkloadKind,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    return this.kubeService.scaleWorkload(kind, namespace, name, body);
  }
}
