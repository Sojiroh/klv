import { useState, useRef, useCallback, useEffect } from 'react';
import { type ParsedLog, type StreamOptions } from '../types';
import { isTauri, tauriStreamStart, tauriStreamStop, onStreamLog, onStreamError } from '../lib/tauri';

const MAX_LOGS = 2000;
const IS_TAURI = isTauri();

export function useStream() {
  const [logs, setLogs] = useState<ParsedLog[]>([]);
  const [connected, setConnected] = useState(IS_TAURI);
  const [streaming, setStreaming] = useState(false);
  const streamIdRef = useRef<string>('default');
  const socketRef = useRef<ReturnType<typeof import('socket.io-client').io> | null>(null);
  const listenersReady = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (IS_TAURI) {
      let unlistenLog: (() => void) | null = null;
      let unlistenError: (() => void) | null = null;

      listenersReady.current = Promise.all([
        onStreamLog((log) => {
          setLogs((prev) => {
            const next = [...prev, log];
            return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
          });
        }).then((fn) => { unlistenLog = fn; }),
        onStreamError((err) => {
          console.error(`Stream error — ${err.podName}: ${err.error}`);
        }).then((fn) => { unlistenError = fn; }),
      ]).then(() => {});

      return () => {
        unlistenLog?.();
        unlistenError?.();
      };
    }

    import('socket.io-client').then(({ io }) => {
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
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const start = useCallback(async (options: StreamOptions) => {
    setLogs([]);
    if (IS_TAURI) {
      if (listenersReady.current) {
        await listenersReady.current;
      }
      const id = `stream-${Date.now()}`;
      streamIdRef.current = id;
      await tauriStreamStart(id, options);
    } else {
      socketRef.current?.emit('stream:start', options);
    }
    setStreaming(true);
  }, []);

  const stop = useCallback(() => {
    if (IS_TAURI) {
      tauriStreamStop(streamIdRef.current);
    } else {
      socketRef.current?.emit('stream:stop');
    }
    setStreaming(false);
  }, []);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, connected, streaming, start, stop, clear };
}
