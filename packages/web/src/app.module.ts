import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { KubeModule } from './kube/kube.module';
import { LogModule } from './log/log.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'client-dist'),
      exclude: ['/api/(.*)'],
    }),
    KubeModule,
    LogModule,
  ],
})
export class AppModule {}
