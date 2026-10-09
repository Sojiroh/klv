import { useState, useRef, useCallback, useEffect } from 'react';
import type {
  ParsedLog,
  StreamEndEvent,
  StreamErrorEvent,
  StreamLogEvent,
  StreamNotice,
  StreamOptions,
} from '../types';
import {
  isTauri,
  tauriStreamStart,
  tauriStreamStop,
  onStreamLog,
  onStreamError,
  onStreamEnd,
} from '../lib/tauri';
import { errorMessage } from '../lib/api';

const MAX_LOGS = 2000;
const MAX_NOTICES = 100;
const IS_TAURI = isTauri();

function appendCapped(prev: ParsedLog[], batch: ParsedLog[]): ParsedLog[] {
  const next = prev.concat(batch);
  return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
}

function newStreamId(): string {
  return `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useStream() {
  const [logs, setLogs] = useState<ParsedLog[]>([]);
  const [notices, setNotices] = useState<StreamNotice[]>([]);
  const [connected, setConnected] = useState(IS_TAURI);
  const [streaming, setStreaming] = useState(false);
  const streamIdRef = useRef<string | null>(null);
  const activePodsRef = useRef<Set<string>>(new Set());
  const socketRef = useRef<ReturnType<typeof import('socket.io-client').io> | null>(null);
  const listenersReady = useRef<Promise<void> | null>(null);

  const addNotice = useCallback((notice: StreamNotice) => {
    setNotices((prev) => [...prev, notice].slice(-MAX_NOTICES));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const finishStream = () => {
      streamIdRef.current = null;
      activePodsRef.current.clear();
      setStreaming(false);
    };

    const onLog = (event: StreamLogEvent) => {
      if (event.streamId !== streamIdRef.current) return;
      setLogs((prev) => appendCapped(prev, event.logs));
    };

    const onError = (event: StreamErrorEvent) => {
      if (event.streamId !== streamIdRef.current) return;
      addNotice({ kind: 'error', podName: event.podName, message: event.error });
      if (!event.podName) {
        finishStream();
        return;
      }
      activePodsRef.current.delete(event.podName);
      if (activePodsRef.current.size === 0) finishStream();
    };

    const onEnd = (event: StreamEndEvent) => {
      if (event.streamId !== streamIdRef.current) return;
      addNotice({ kind: 'end', podName: event.podName, message: 'Stream ended' });
      activePodsRef.current.delete(event.podName);
      if (activePodsRef.current.size === 0) finishStream();
    };

    if (IS_TAURI) {
      const unlisteners: Array<() => void> = [];

      listenersReady.current = Promise.all([
        onStreamLog(onLog),
        onStreamError(onError),
        onStreamEnd(onEnd),
      ]).then((fns) => {
        if (cancelled) fns.forEach((fn) => fn());
        else unlisteners.push(...fns);
      });

      return () => {
        cancelled = true;
        unlisteners.forEach((fn) => fn());
        const id = streamIdRef.current;
        if (id) {
          streamIdRef.current = null;
          tauriStreamStop(id).catch((err: unknown) => console.error('Stream stop failed:', err));
        }
      };
    }

    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const socket = io({ transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('connect', () => setConnected(true));
      socket.on('disconnect', () => {
        setConnected(false);
        if (streamIdRef.current) {
          addNotice({ kind: 'error', message: 'Connection to server lost' });
          finishStream();
        }
      });
      socket.on('stream:log', onLog);
      socket.on('stream:error', onError);
      socket.on('stream:end', onEnd);
    });

    return () => {
      cancelled = true;
      streamIdRef.current = null;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [addNotice]);

  const start = useCallback(async (options: StreamOptions) => {
    if (options.pods.length === 0) return;

    const id = newStreamId();
    streamIdRef.current = id;
    activePodsRef.current = new Set(options.pods);
    setLogs([]);
    setNotices([]);
    setStreaming(true);

    try {
      if (IS_TAURI) {
        if (listenersReady.current) await listenersReady.current;
        await tauriStreamStart(id, options);
      } else {
        const socket = socketRef.current;
        if (!socket) throw new Error('Not connected to server');
        socket.emit('stream:start', { streamId: id, ...options });
      }
    } catch (err) {
      if (streamIdRef.current !== id) return;
      streamIdRef.current = null;
      activePodsRef.current.clear();
      setStreaming(false);
      addNotice({
        kind: 'error',
        message: errorMessage(err),
      });
    }
  }, [addNotice]);

  const stop = useCallback(() => {
    const id = streamIdRef.current;
    streamIdRef.current = null;
    activePodsRef.current.clear();
    if (IS_TAURI) {
      if (id) tauriStreamStop(id).catch((err: unknown) => console.error('Stream stop failed:', err));
    } else {
      socketRef.current?.emit('stream:stop');
    }
    setStreaming(false);
  }, []);

  const clear = useCallback(() => {
    setLogs([]);
    setNotices([]);
  }, []);

  return { logs, notices, connected, streaming, start, stop, clear };
}
