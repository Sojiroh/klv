import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { parseLogLine, matchesFilter, type LogFilter, type LogLevel } from '@klv/core';
import { KubeService } from '../kube/kube.service';

interface StreamStartPayload {
  namespace: string;
  pods: string[];
  container?: string;
  filters?: {
    level?: string;
    search?: string;
    excludePatterns?: string[];
  };
}

@WebSocketGateway({ cors: true })
export class LogGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private cleanupMap = new Map<string, (() => void)[]>();

  constructor(private readonly kubeService: KubeService) {}

  handleDisconnect(client: Socket) {
    this.stopStreams(client.id);
  }

  @SubscribeMessage('stream:start')
  async handleStreamStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: StreamStartPayload,
  ) {
    // Stop existing streams for this client
    this.stopStreams(client.id);

    const cleanups: (() => void)[] = [];
    const kubeClient = this.kubeService.getClient();

    const filter: LogFilter = {};
    if (payload.filters?.level) filter.minLevel = payload.filters.level.toUpperCase() as LogLevel;
    if (payload.filters?.search) filter.search = payload.filters.search;
    if (payload.filters?.excludePatterns) filter.excludePatterns = payload.filters.excludePatterns;

    for (const podName of payload.pods) {
      try {
        const cleanup = await kubeClient.streamLogs(
          {
            namespace: payload.namespace,
            podName,
            container: payload.container,
            follow: true,
            tailLines: 50,
          },
          (line, pod) => {
            const parsed = parseLogLine(line, pod);
            if (matchesFilter(parsed, filter)) {
              client.emit('stream:log', parsed);
            }
          },
          (err, pod) => {
            client.emit('stream:error', { podName: pod, error: err.message });
          },
        );
        cleanups.push(cleanup);
      } catch (err: any) {
        client.emit('stream:error', { podName, error: err.message });
      }
    }

    this.cleanupMap.set(client.id, cleanups);
  }

  @SubscribeMessage('stream:stop')
  handleStreamStop(@ConnectedSocket() client: Socket) {
    this.stopStreams(client.id);
  }

  private stopStreams(clientId: string) {
    const cleanups = this.cleanupMap.get(clientId);
    if (cleanups) {
      cleanups.forEach((fn) => fn());
      this.cleanupMap.delete(clientId);
    }
  }
}
