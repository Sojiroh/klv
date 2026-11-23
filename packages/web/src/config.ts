export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 3000);

const WILDCARD_HOSTS: Record<string, true> = { '': true, '0.0.0.0': true, '::': true, '[::]': true };
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

// El propio HOST solo cuenta cuando es una dirección concreta, no un comodín
function ownHosts(): string[] {
  const hosts = ['localhost', '127.0.0.1', '[::1]'];
  if (!Object.hasOwn(WILDCARD_HOSTS, HOST)) {
    hosts.push(HOST.includes(':') && !HOST.startsWith('[') ? `[${HOST}]` : HOST);
  }
  return hosts;
}

// Orígenes http(s) en la forma normalizada que envía el navegador; las entradas inválidas se ignoran
function parseOrigins(candidates: string[]): URL[] {
  const origins: URL[] = [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (Object.hasOwn(DEFAULT_PORTS, url.protocol)) origins.push(url);
    } catch {
      // No es una URL (p. ej. un valor mal escrito en KLV_ALLOWED_ORIGINS)
    }
  }
  return origins;
}

const ORIGIN_URLS = parseOrigins([
  ...ownHosts().map((host) => `http://${host}:${PORT}`),
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.KLV_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()),
]);

// Valores aceptados en la cabecera Origin (HTTP y WebSocket)
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(ORIGIN_URLS.map((url) => url.origin));

// Valores aceptados en la cabecera Host, como hostname:puerto: los hosts de los orígenes permitidos
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(
  ORIGIN_URLS.map((url) => `${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol]}`),
);
