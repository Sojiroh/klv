import { Module } from '@nestjs/common';
import { LogController } from './log.controller';
import { LogService } from './log.service';
import { LogGateway } from './log.gateway';
import { KubeModule } from '../kube/kube.module';

@Module({
  imports: [KubeModule],
  controllers: [LogController],
  providers: [LogService, LogGateway],
})
export class LogModule {}
