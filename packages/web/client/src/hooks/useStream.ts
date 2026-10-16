import { useState, useRef, useCallback, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
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

const MAX_NOTICES = 100;
const FLUSH_INTERVAL_MS = 100;
const IS_TAURI = isTauri();
/** Heap per buffered log measured in Chromium (parsed objects + explorer caches): a fixed part plus one per raw character. */
const HEAP_BYTES_PER_LOG = 700;
const HEAP_BYTES_PER_RAW_CHAR = 1.3;

interface StreamScope {
  namespace: string;
  container?: string;
}

function newStreamId(): string {
  return `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useStream({ bufferSize }: { bufferSize: number }) {
  const [logs, setLogs] = useState<ParsedLog[]>([]);
  const [dropped, setDropped] = useState(0);
  const [approxBytes, setApproxBytes] = useState(0);
  const [notices, setNotices] = useState<StreamNotice[]>([]);
  const [connected, setConnected] = useState(IS_TAURI);
  const [streaming, setStreaming] = useState(false);
  const streamIdRef = useRef<string | null>(null);
  const activePodsRef = useRef<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);
  const listenersReady = useRef<Promise<void> | null>(null);
  const scopeRef = useRef<StreamScope | null>(null);
  const bufferSizeRef = useRef(bufferSize);
  const logsRef = useRef<ParsedLog[]>([]);
  const rawCharsRef = useRef(0);
  const pendingRef = useRef<ParsedLog[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  bufferSizeRef.current = bufferSize;

  const addNotice = useCallback((notice: StreamNotice) => {
    setNotices((prev) => [...prev, notice].slice(-MAX_NOTICES));
  }, []);

  /** Appends `batch` to the buffer, keeping the newest `bufferSize` lines (Infinity = all) and counting the discarded ones. */
  const commit = useCallback((batch: ParsedLog[]) => {
    const size = bufferSizeRef.current;
    const combined = batch.length > 0 ? logsRef.current.concat(batch) : logsRef.current;
    const overflow = combined.length - size;
    if (overflow <= 0 && batch.length === 0) return;
    let rawChars = rawCharsRef.current;
    for (const log of batch) rawChars += log.raw.length;
    if (overflow > 0) {
      for (let i = 0; i < overflow; i++) rawChars -= combined[i].raw.length;
    }
    const next = overflow > 0 ? combined.slice(overflow) : combined;
    logsRef.current = next;
    rawCharsRef.current = rawChars;
    setLogs(next);
    setApproxBytes(next.length * HEAP_BYTES_PER_LOG + rawChars * HEAP_BYTES_PER_RAW_CHAR);
    if (overflow > 0) setDropped((prev) => prev + overflow);
  }, []);

  const cancelFlush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingRef.current = [];
  }, []);

  const resetBuffer = useCallback(() => {
    cancelFlush();
    logsRef.current = [];
    rawCharsRef.current = 0;
    setLogs([]);
    setApproxBytes(0);
    setDropped(0);
  }, [cancelFlush]);

  useEffect(() => {
    commit([]);
  }, [bufferSize, commit]);

  useEffect(() => {
    let cancelled = false;

    const finishStream = () => {
      streamIdRef.current = null;
      activePodsRef.current.clear();
      setStreaming(false);
    };

    const flush = () => {
      flushTimerRef.current = null;
      const batch = pendingRef.current;
      pendingRef.current = [];
      commit(batch);
    };

    const onLog = (event: StreamLogEvent) => {
      if (event.streamId !== streamIdRef.current) return;
      const scope = scopeRef.current;
      const pending = pendingRef.current;
      for (const log of event.logs) {
        pending.push(
          scope
            ? {
                ...log,
                namespace: scope.namespace,
                ...(scope.container ? { container: scope.container } : {}),
              }
            : log,
        );
      }
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
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
        cancelFlush();
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
      cancelFlush();
      streamIdRef.current = null;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [addNotice, cancelFlush, commit]);

  const start = useCallback(async (options: StreamOptions) => {
    if (options.pods.length === 0) return;

    const id = newStreamId();
    streamIdRef.current = id;
    activePodsRef.current = new Set(options.pods);
    scopeRef.current = { namespace: options.namespace, container: options.container };
    resetBuffer();
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
  }, [addNotice, resetBuffer]);

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
    resetBuffer();
    setNotices([]);
  }, [resetBuffer]);

  return { logs, dropped, approxBytes, notices, connected, streaming, start, stop, clear };
}
