import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './app.filter';
import { HOST, PORT } from './config';
import { requestGuard } from './request-guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(requestGuard);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AppExceptionFilter(app.get(HttpAdapterHost)));
  app.enableShutdownHooks();
  await app.listen(PORT, HOST);
  const displayHost = HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`KLV Web running on http://${displayHost}:${PORT}`);
}
bootstrap();
