import { Controller, Get, Put, Param, Query } from '@nestjs/common';
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

  @Get('deployments/:namespace')
  getDeployments(@Param('namespace') namespace: string) {
    return this.kubeService.getDeployments(namespace);
  }
}
