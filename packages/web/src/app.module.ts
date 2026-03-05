import { Module } from '@nestjs/common';
import { KubeModule } from './kube/kube.module';

@Module({
  imports: [KubeModule],
})
export class AppModule {}
