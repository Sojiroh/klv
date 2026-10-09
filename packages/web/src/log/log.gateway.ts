import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import { Server, Socket } from 'socket.io';
import {
  parseLogLine,
  matchesFilter,
  parseLevel,
  assertK8sName,
  type LogFilter,
  type ParsedLog,
} from '@klv/core';
import { ALLOWED_ORIGINS } from '../config';
import { KubeService } from '../kube/kube.service';

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH = 500;
const MAX_PODS = 100;

interface StreamStartPayload {
  streamId: string;
  namespace: string;
  pods: string[];
  container?: string;
  filters?: {
    level?: string;
    search?: string;
    excludePatterns?: string[];
  };
}

interface StreamSession {
  streamId: string;
  stopped: boolean;
  cleanups: (() => void)[];
  pending: ParsedLog[];
  timer?: NodeJS.Timeout;
}

function validatePayload(payload: unknown): StreamStartPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Payload de stream inválido');
  }
  const { streamId, namespace, pods, container, filters } = payload as Record<string, unknown>;

  if (typeof streamId !== 'string' || streamId === '') {
    throw new Error('streamId debe ser un string no vacío');
  }

  if (typeof namespace !== 'string') throw new Error('namespace debe ser un string');
  assertK8sName('namespace', namespace);

  if (!Array.isArray(pods) || pods.length === 0 || pods.length > MAX_PODS) {
    throw new Error(`pods debe ser un arreglo de 1 a ${MAX_PODS} elementos`);
  }
  for (const pod of pods) {
    if (typeof pod !== 'string') throw new Error('pods debe contener solo strings');
    assertK8sName('pod', pod);
  }

  if (container != null) {
    if (typeof container !== 'string') throw new Error('container debe ser un string');
    assertK8sName('container', container);
  }

  if (filters != null) validateFilters(filters);

  return payload as StreamStartPayload;
}

function validateFilters(filters: unknown) {
  if (typeof filters !== 'object') throw new Error('filters debe ser un objeto');
  const { level, search, excludePatterns } = filters as Record<string, unknown>;

  if (level != null && level !== '') {
    if (typeof level !== 'string' || parseLevel(level) === 'UNKNOWN') {
      throw new Error(`Nivel inválido: ${String(level)}`);
    }
  }
  if (search != null && typeof search !== 'string') throw new Error('search debe ser un string');
  if (
    excludePatterns != null &&
    (!Array.isArray(excludePatterns) || excludePatterns.some((p) => typeof p !== 'string'))
  ) {
    throw new Error('excludePatterns debe ser un arreglo de strings');
  }
}

function allowRequest(
  req: IncomingMessage,
  callback: (err: string | null | undefined, success: boolean) => void,
) {
  const origin = req.headers.origin;
  callback(null, origin === undefined || ALLOWED_ORIGINS.has(origin));
}

@WebSocketGateway({ cors: { origin: [...ALLOWED_ORIGINS] }, allowRequest })
export class LogGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private sessions = new Map<string, StreamSession>();

  constructor(private readonly kubeService: KubeService) {}

  handleDisconnect(client: Socket) {
    this.stopStreams(client.id);
  }

  @SubscribeMessage('stream:start')
  async handleStreamStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: unknown,
  ) {
    // Stop existing streams for this client
    this.stopStreams(client.id);

    const rawStreamId = (payload as { streamId?: unknown } | null)?.streamId;
    const streamId = typeof rawStreamId === 'string' ? rawStreamId : '';

    let request: StreamStartPayload;
    try {
      request = validatePayload(payload);
    } catch (err) {
      client.emit('stream:error', { streamId, error: (err as Error).message });
      return;
    }

    // Registered before any await so a concurrent stop/start can invalidate it
    const session: StreamSession = { streamId, stopped: false, cleanups: [], pending: [] };
    this.sessions.set(client.id, session);

    const filter: LogFilter = {};
    if (request.filters?.level) filter.minLevel = parseLevel(request.filters.level);
    if (request.filters?.search) filter.search = request.filters.search;
    if (request.filters?.excludePatterns) filter.excludePatterns = request.filters.excludePatterns;

    const isLive = () => !session.stopped && client.connected;

    const flush = () => {
      clearTimeout(session.timer);
      session.timer = undefined;
      if (session.pending.length === 0) return;
      const logs = session.pending;
      session.pending = [];
      client.emit('stream:log', { streamId, logs });
    };

    const kubeClient = this.kubeService.getClient();

    await Promise.all(
      request.pods.map(async (podName) => {
        const cleanup = await kubeClient.streamLogs(
          {
            namespace: request.namespace,
            podName,
            container: request.container ?? undefined,
            follow: true,
            tailLines: 50,
            timestamps: true,
          },
          {
            onLine: (line, pod) => {
              if (!isLive()) return;
              const parsed = parseLogLine(line, pod);
              if (!matchesFilter(parsed, filter)) return;
              session.pending.push(parsed);
              if (session.pending.length >= MAX_BATCH) flush();
              else session.timer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
            },
            onError: (err, pod) => {
              if (!isLive()) return;
              flush();
              client.emit('stream:error', { streamId, podName: pod, error: err.message });
            },
            onEnd: (pod) => {
              if (!isLive()) return;
              flush();
              client.emit('stream:end', { streamId, podName: pod });
            },
          },
        );

        if (!isLive()) {
          cleanup();
          this.stopSession(client.id, session);
          return;
        }
        session.cleanups.push(cleanup);
      }),
    );
  }

  @SubscribeMessage('stream:stop')
  handleStreamStop(@ConnectedSocket() client: Socket) {
    this.stopStreams(client.id);
  }

  private stopStreams(clientId: string) {
    const session = this.sessions.get(clientId);
    if (session) this.stopSession(clientId, session);
  }

  private stopSession(clientId: string, session: StreamSession) {
    session.stopped = true;
    clearTimeout(session.timer);
    session.timer = undefined;
    session.pending = [];
    const cleanups = session.cleanups;
    session.cleanups = [];
    cleanups.forEach((fn) => fn());
    if (this.sessions.get(clientId) === session) this.sessions.delete(clientId);
  }
}
