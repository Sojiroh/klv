import { HttpException, HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

// Bloquea POST/PUT cross-site desde formularios HTML (que no pueden enviar application/json)
@Injectable()
export class JsonContentTypeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: { 'content-type'?: string } }>();
    if (!/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) {
      throw new HttpException('Content-Type debe ser application/json', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    }
    return true;
  }
}
