import { Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JsonContentTypeGuard } from '../json-content-type.guard';
import { KubeService } from './kube.service';

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

  @Get('deployments/:namespace')
  getDeployments(@Param('namespace') namespace: string) {
    return this.kubeService.getDeployments(namespace);
  }

  @Post('deployments/:namespace/:name/restart')
  @HttpCode(200)
  @UseGuards(JsonContentTypeGuard)
  restartDeployment(@Param('namespace') namespace: string, @Param('name') name: string) {
    return this.kubeService.restartDeployment(namespace, name);
  }
}
