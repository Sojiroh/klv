import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { HistoryModule } from './history/history.module';
import { KubeModule } from './kube/kube.module';
import { LogModule } from './log/log.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'client-dist'),
      exclude: ['/api/{*path}'],
    }),
    KubeModule,
    LogModule,
    HistoryModule,
  ],
})
export class AppModule {}
