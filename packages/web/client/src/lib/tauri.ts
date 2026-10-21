import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  StreamEndEvent,
  StreamErrorEvent,
  StreamLogEvent,
  StreamOptions,
} from '../types';
import { WORKLOAD_KINDS, WORKLOAD_RESOURCES } from './workloads';

// `deployments` -> `Deployment`, …
const WORKLOAD_BY_RESOURCE = new Map(WORKLOAD_KINDS.map((kind) => [WORKLOAD_RESOURCES[kind], kind]));

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface RouteMatch {
  command: string;
  args: Record<string, unknown>;
}

function optionalNumber(params: URLSearchParams, key: string): number | undefined {
  return params.has(key) ? Number(params.get(key)) : undefined;
}

function optionalBoolean(params: URLSearchParams, key: string): boolean | undefined {
  return params.has(key) ? params.get(key) === 'true' : undefined;
}

function matchRoute(url: string): RouteMatch | null {
  const u = new URL(url, 'http://localhost');
  const path = u.pathname;
  const params = u.searchParams;

  if (path === '/api/contexts') {
    return { command: 'get_contexts', args: {} };
  }

  if (path === '/api/namespaces') {
    return { command: 'get_namespaces', args: {} };
  }

  const workloadsMatch = path.match(/^\/api\/([^/]+)\/([^/]+)$/);
  const workloadKind = workloadsMatch ? WORKLOAD_BY_RESOURCE.get(workloadsMatch[1]) : undefined;
  if (workloadsMatch && workloadKind) {
    return {
      command: 'get_workloads',
      args: { kind: workloadKind, namespace: decodeURIComponent(workloadsMatch[2]) },
    };
  }

  const containerLogMatch = path.match(
    /^\/api\/pods\/([^/]+)\/container\/([^/]+)\/logs$/,
  );
  if (containerLogMatch) {
    return {
      command: 'get_container_logs',
      args: {
        namespace: decodeURIComponent(containerLogMatch[1]),
        container: decodeURIComponent(containerLogMatch[2]),
        tail: optionalNumber(params, 'tail'),
        since: optionalNumber(params, 'since'),
        level: params.get('level') || undefined,
        search: params.get('search') || undefined,
        previous: optionalBoolean(params, 'previous'),
      },
    };
  }

  const podLogMatch = path.match(/^\/api\/pods\/([^/]+)\/([^/]+)\/logs$/);
  if (podLogMatch) {
    return {
      command: 'get_pod_logs',
      args: {
        params: {
          namespace: decodeURIComponent(podLogMatch[1]),
          pod: decodeURIComponent(podLogMatch[2]),
          container: params.get('container') || undefined,
          tail: optionalNumber(params, 'tail'),
          since: optionalNumber(params, 'since'),
          level: params.get('level') || undefined,
          search: params.get('search') || undefined,
          previous: optionalBoolean(params, 'previous'),
        },
      },
    };
  }

  const podsMatch = path.match(/^\/api\/pods\/([^/]+)$/);
  if (podsMatch) {
    return {
      command: 'get_pods',
      args: { namespace: decodeURIComponent(podsMatch[1]) },
    };
  }

  const containersMatch = path.match(/^\/api\/containers\/([^/]+)$/);
  if (containersMatch) {
    return {
      command: 'get_containers',
      args: {
        namespace: decodeURIComponent(containersMatch[1]),
        context: params.get('context') || undefined,
        label: params.get('label') || undefined,
      },
    };
  }

  if (path === '/api/history/config') {
    return { command: 'history_get_config', args: {} };
  }

  if (path === '/api/history/status') {
    return { command: 'history_status', args: {} };
  }

  return null;
}

interface InvokeOptions {
  method?: string;
  body?: unknown;
}

export async function invokeApi<T>(url: string, options: InvokeOptions = {}): Promise<T> {
  const { method = 'GET', body } = options;
  const path = new URL(url, 'http://localhost').pathname;

  if (method === 'PUT') {
    if (path === '/api/history/config') {
      return invoke<T>('history_set_config', { config: body });
    }
    const ctxMatch = path.match(/^\/api\/contexts\/([^/]+)$/);
    if (!ctxMatch) {
      throw new Error(`No Tauri command mapped for: PUT ${url}`);
    }
    return invoke<T>('set_context', { name: decodeURIComponent(ctxMatch[1]) });
  }

  if (method === 'POST') {
    if (path === '/api/history/query') return invoke<T>('history_query', { request: body });
    if (path === '/api/history/clear') return invoke<T>('history_clear');
    const actionMatch = path.match(/^\/api\/([^/]+)\/([^/]+)\/([^/]+)\/(restart|scale)$/);
    const kind = actionMatch ? WORKLOAD_BY_RESOURCE.get(actionMatch[1]) : undefined;
    if (actionMatch && kind) {
      const target = {
        kind,
        namespace: decodeURIComponent(actionMatch[2]),
        name: decodeURIComponent(actionMatch[3]),
      };
      if (actionMatch[4] === 'restart') return invoke<T>('restart_workload', target);
      const replicas = body !== null && typeof body === 'object' && 'replicas' in body ? body.replicas : undefined;
      return invoke<T>('scale_workload', { ...target, replicas });
    }
    throw new Error(`No Tauri command mapped for: POST ${url}`);
  }

  if (method === 'DELETE') {
    const podMatch = path.match(/^\/api\/pods\/([^/]+)\/([^/]+)$/);
    if (!podMatch) {
      throw new Error(`No Tauri command mapped for: DELETE ${url}`);
    }
    return invoke<T>('delete_pod', {
      namespace: decodeURIComponent(podMatch[1]),
      name: decodeURIComponent(podMatch[2]),
    });
  }

  const route = matchRoute(url);
  if (!route) {
    throw new Error(`No Tauri command mapped for: ${url}`);
  }
  return invoke<T>(route.command, route.args);
}

export async function exportSave(defaultName: string, contents: string): Promise<string | null> {
  return invoke<string | null>('export_save', { defaultName, contents });
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
  callback: (event: StreamLogEvent) => void,
): Promise<UnlistenFn> {
  return listen<StreamLogEvent>('stream:log', (event) => callback(event.payload));
}

export function onStreamError(
  callback: (event: StreamErrorEvent) => void,
): Promise<UnlistenFn> {
  return listen<StreamErrorEvent>('stream:error', (event) => callback(event.payload));
}

export function onStreamEnd(
  callback: (event: StreamEndEvent) => void,
): Promise<UnlistenFn> {
  return listen<StreamEndEvent>('stream:end', (event) => callback(event.payload));
}
