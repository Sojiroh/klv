import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { type ParsedLog, type StreamOptions } from '../types';

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface RouteMatch {
  command: string;
  args: Record<string, unknown>;
}

function matchRoute(url: string): RouteMatch | null {
  const u = new URL(url, 'http://localhost');
  const path = u.pathname;
  const params = u.searchParams;

  if (path === '/api/contexts') {
    return { command: 'get_contexts', args: {} };
  }

  const ctxMatch = path.match(/^\/api\/contexts\/(.+)$/);
  if (ctxMatch) {
    return { command: 'set_context', args: { name: ctxMatch[1] } };
  }

  if (path === '/api/namespaces') {
    return { command: 'get_namespaces', args: {} };
  }

  const deployMatch = path.match(/^\/api\/deployments\/([^/]+)$/);
  if (deployMatch) {
    return { command: 'get_deployments', args: { namespace: deployMatch[1] } };
  }

  const containerLogMatch = path.match(
    /^\/api\/pods\/([^/]+)\/container\/([^/]+)\/logs$/,
  );
  if (containerLogMatch) {
    return {
      command: 'get_container_logs',
      args: {
        namespace: containerLogMatch[1],
        container: containerLogMatch[2],
        tail: params.has('tail') ? Number(params.get('tail')) : undefined,
        since: params.has('since') ? Number(params.get('since')) : undefined,
        level: params.get('level') || undefined,
        search: params.get('search') || undefined,
      },
    };
  }

  const podLogMatch = path.match(/^\/api\/pods\/([^/]+)\/([^/]+)\/logs$/);
  if (podLogMatch) {
    return {
      command: 'get_pod_logs',
      args: {
        params: {
          namespace: podLogMatch[1],
          pod: podLogMatch[2],
          container: params.get('container') || undefined,
          tail: params.has('tail') ? Number(params.get('tail')) : undefined,
          since: params.has('since') ? Number(params.get('since')) : undefined,
          level: params.get('level') || undefined,
          search: params.get('search') || undefined,
        },
      },
    };
  }

  const podsMatch = path.match(/^\/api\/pods\/([^/]+)$/);
  if (podsMatch) {
    return {
      command: 'get_pods',
      args: { namespace: podsMatch[1] },
    };
  }

  return null;
}

export async function invokeApi<T>(url: string, options?: { method?: string }): Promise<T> {
  if (options?.method === 'PUT') {
    const ctxMatch = url.match(/\/api\/contexts\/(.+)/);
    if (ctxMatch) {
      return invoke<T>('set_context', { name: decodeURIComponent(ctxMatch[1]) });
    }
  }

  const route = matchRoute(url);
  if (!route) {
    throw new Error(`No Tauri command mapped for: ${url}`);
  }
  return invoke<T>(route.command, route.args);
}

export async function tauriStreamStart(
  streamId: string,
  options: StreamOptions,
): Promise<void> {
  await invoke('stream_start', { streamId, payload: options });
}

export async function tauriStreamStop(streamId: string): Promise<void> {
  await invoke('stream_stop', { streamId });
}

export function onStreamLog(
  callback: (log: ParsedLog) => void,
): Promise<UnlistenFn> {
  return listen<ParsedLog>('stream:log', (event: { payload: ParsedLog }) => callback(event.payload));
}

export function onStreamError(
  callback: (err: { podName: string; error: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ podName: string; error: string }>('stream:error', (event: { payload: { podName: string; error: string } }) =>
    callback(event.payload),
  );
}
