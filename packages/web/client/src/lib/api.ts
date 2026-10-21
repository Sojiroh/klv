import { isTauri, invokeApi } from './tauri';

interface RequestOptions {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

async function responseError(res: Response): Promise<Error> {
  let message = '';
  try {
    const body: unknown = await res.json();
    const raw = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
    if (Array.isArray(raw)) message = raw.join(', ');
    else if (typeof raw === 'string') message = raw;
  } catch {
    // cuerpo no JSON
  }
  return new Error(message || `HTTP ${res.status}`);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;

  if (isTauri()) {
    try {
      return await invokeApi<T>(path, { method, body });
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  }

  const res = await fetch(path, {
    method,
    signal,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await responseError(res);
  // 204 No Content (e.g. DELETE): callers use `apiRequest<void>`
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
