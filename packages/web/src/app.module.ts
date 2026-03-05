import { Module } from '@nestjs/common';
import { KubeModule } from './kube/kube.module';
import { LogModule } from './log/log.module';

@Module({
  imports: [KubeModule, LogModule],
})
export class AppModule {}
