import { Module } from '@nestjs/common';
import { KubeController } from './kube.controller';
import { KubeService } from './kube.service';

@Module({
  controllers: [KubeController],
  providers: [KubeService],
  exports: [KubeService],
})
export class KubeModule {}
