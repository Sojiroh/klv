export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 3000);

export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.KLV_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
]);
