import { useState, useRef, useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

interface ParsedLog {
  raw: string;
  isJson: boolean;
  timestamp?: string;
  level: string;
  message: string;
  service?: string;
  podName?: string;
  extra: Record<string, unknown>;
}

interface StreamOptions {
  namespace: string;
  pods: string[];
  container?: string;
  filters?: {
    level?: string;
    search?: string;
  };
}

const MAX_LOGS = 2000;

export function useStream() {
  const [logs, setLogs] = useState<ParsedLog[]>([]);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => {
      setConnected(false);
      setStreaming(false);
    });

    socket.on('stream:log', (log: ParsedLog) => {
      setLogs((prev) => {
        const next = [...prev, log];
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
      });
    });

    socket.on('stream:error', (err: { podName: string; error: string }) => {
      console.error(`Stream error for ${err.podName}: ${err.error}`);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const start = useCallback((options: StreamOptions) => {
    setLogs([]);
    socketRef.current?.emit('stream:start', options);
    setStreaming(true);
  }, []);

  const stop = useCallback(() => {
    socketRef.current?.emit('stream:stop');
    setStreaming(false);
  }, []);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, connected, streaming, start, stop, clear };
}
