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
import { parseLogLine, assertK8sName, type LogStream, type ParsedLog } from '@klv/core';
import { ALLOWED_ORIGINS } from '../config';
import { KubeService } from '../kube/kube.service';
import { isRequestAllowed } from '../request-guard';

const FLUSH_INTERVAL_MS = 100;
const DRAIN_POLL_MS = 25;
const MAX_BATCH = 500;
const MAX_PODS = 100;
// Líneas encoladas a partir de las cuales se pausan los streams de los pods
// (el socket no drena); se reanudan cuando la cola queda vacía.
const HIGH_WATER_MARK = 5000;

interface StreamStartPayload {
  streamId: string;
  namespace: string;
  pods: string[];
  container?: string;
}

// Elemento de la cola ordenada: una línea, o una acción (error/fin de pod) que
// debe emitirse después de las líneas que la preceden.
type PendingEntry = ParsedLog | (() => void);

interface StreamSession {
  streamId: string;
  stopped: boolean;
  streams: LogStream[];
  paused: boolean;
  pending: PendingEntry[];
  timer?: NodeJS.Timeout;
}

function validatePayload(payload: unknown): StreamStartPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Payload de stream inválido');
  }
  const { streamId, namespace, pods, container } = payload as Record<string, unknown>;

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

  return payload as StreamStartPayload;
}

function allowRequest(
  req: IncomingMessage,
  callback: (err: string | null | undefined, success: boolean) => void,
) {
  callback(null, isRequestAllowed(req.headers));
}

// Solo WebSocket: su handshake siempre lleva Origin. El long-polling (y su variante JSONP) permitiría
// abrir una sesión desde otra página sin cabecera Origin
@WebSocketGateway({ cors: { origin: [...ALLOWED_ORIGINS] }, allowRequest, transports: ['websocket'] })
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
    const session: StreamSession = {
      streamId,
      stopped: false,
      streams: [],
      paused: false,
      pending: [],
    };
    this.sessions.set(client.id, session);

    const isLive = () => !session.stopped && client.connected;

    let waitingDrain = false;
    const waitForDrain = () => {
      if (waitingDrain) return;
      waitingDrain = true;
      const transport = client.conn.transport;
      const onDrain = () => {
        if (!waitingDrain) return;
        waitingDrain = false;
        transport.off('ready', onDrain);
        clearTimeout(session.timer);
        session.timer = undefined;
        flush();
      };
      // `ready` se emite cuando el transporte vuelve a ser escribible
      transport.once('ready', onDrain);
      // Respaldo por si el evento no llega (versiones de engine.io que no emiten `ready`)
      clearTimeout(session.timer);
      session.timer = setTimeout(onDrain, DRAIN_POLL_MS);
    };

    const setPaused = (paused: boolean) => {
      if (session.paused === paused) return;
      session.paused = paused;
      for (const stream of session.streams) {
        if (paused) stream.pause();
        else stream.resume();
      }
    };

    const flush = () => {
      if (!isLive()) return;
      if (!waitingDrain) {
        clearTimeout(session.timer);
        session.timer = undefined;
      }
      // Mientras el transporte de engine.io sigue escribiendo el lote anterior no es
      // escribible: lo nuevo se quedaría en su cola interna, así que espera aquí
      while (session.pending.length > 0 && client.conn.transport.writable) {
        const head = session.pending[0];
        if (typeof head === 'function') {
          session.pending.shift();
          head();
          if (!isLive()) return;
          continue;
        }
        let count = 1;
        while (
          count < MAX_BATCH &&
          count < session.pending.length &&
          typeof session.pending[count] !== 'function'
        ) {
          count++;
        }
        const logs = session.pending.splice(0, count) as ParsedLog[];
        client.emit('stream:log', { streamId, logs });
      }
      if (session.pending.length > 0) waitForDrain();
      else setPaused(false);
    };

    const kubeClient = this.kubeService.getClient();

    const pods = [...new Set(request.pods)];
    await Promise.all(
      pods.map(async (podName) => {
        const stream = await kubeClient.streamLogs(
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
              session.pending.push(parseLogLine(line, pod));
              if (session.pending.length >= HIGH_WATER_MARK) setPaused(true);
              if (session.pending.length >= MAX_BATCH) flush();
              else if (session.timer === undefined) session.timer = setTimeout(flush, FLUSH_INTERVAL_MS);
            },
            onError: (err, pod) => {
              if (!isLive()) return;
              session.pending.push(() => {
                client.emit('stream:error', { streamId, podName: pod, error: err.message });
              });
              flush();
            },
            onEnd: (pod) => {
              if (!isLive()) return;
              session.pending.push(() => {
                client.emit('stream:end', { streamId, podName: pod });
              });
              flush();
            },
          },
        );

        if (!isLive()) {
          stream.stop();
          this.stopSession(client.id, session);
          return;
        }
        session.streams.push(stream);
        if (session.paused) stream.pause();
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
    const streams = session.streams;
    session.streams = [];
    streams.forEach((stream) => stream.stop());
    if (this.sessions.get(clientId) === session) this.sessions.delete(clientId);
  }
}
