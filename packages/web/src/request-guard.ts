import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { ALLOWED_HOSTS, ALLOWED_ORIGINS } from './config';

const REJECTION_MESSAGE = 'Solicitud rechazada: host u origen no permitido';

// Valida Host (contra DNS rebinding) y Origin (contra peticiones cross-site).
// Se aplica a todo el HTTP (API y estáticos) y al handshake de Socket.IO.
export function isRequestAllowed(headers: IncomingHttpHeaders): boolean {
  const host = headers.host;
  if (typeof host !== 'string' || host === '') return false;

  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  // Un Host con userinfo, ruta o similar no es un Host válido
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return false;
  }
  const hostAllowed = parsed.port === ''
    ? ALLOWED_HOSTS.has(`${parsed.hostname}:80`) || ALLOWED_HOSTS.has(`${parsed.hostname}:443`)
    : ALLOWED_HOSTS.has(`${parsed.hostname}:${parsed.port}`);
  if (!hostAllowed) return false;

  const origin = headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return false;
  return true;
}

export function requestGuard(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (isRequestAllowed(req.headers)) {
    next();
    return;
  }
  res.statusCode = 403;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ statusCode: 403, message: REJECTION_MESSAGE }));
}
