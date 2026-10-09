import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { KubeError } from '@klv/core';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.httpAdapterHost;
    const response = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      httpAdapter.reply(
        response,
        typeof body === 'string' ? { statusCode: status, message: body } : body,
        status,
      );
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    let statusCode = 500;
    if (exception instanceof KubeError && exception.statusCode != null) {
      if (exception.statusCode >= 400 && exception.statusCode < 500) statusCode = exception.statusCode;
      else if (exception.statusCode >= 500) statusCode = 502;
    }

    httpAdapter.reply(response, { statusCode, message }, statusCode);
  }
}
