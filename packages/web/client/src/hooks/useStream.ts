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
/** Flush cadence: every flush copies the whole buffer and re-renders the explorer, so it stretches with the buffer length. */
const MIN_FLUSH_INTERVAL_MS = 100;
const MAX_FLUSH_INTERVAL_MS = 1000;
const BUFFERED_LINES_PER_MS = 500;
/** While paused the held lines are only trimmed to the buffer size once they exceed it by 1/8 (at least `MIN_PAUSED_SLACK` lines): trims stay rare. */
const PAUSED_SLACK_DIVISOR = 8;
const MIN_PAUSED_SLACK = 256;
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
  const [paused, setPaused] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const [notices, setNotices] = useState<StreamNotice[]>([]);
  const [connected, setConnected] = useState(IS_TAURI);
  const [streaming, setStreaming] = useState(false);
  const streamIdRef = useRef<string | null>(null);
  const activePodsRef = useRef<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);
  const listenersReady = useRef<Promise<void> | null>(null);
  const scopeRef = useRef<StreamScope | null>(null);
  const bufferSizeRef = useRef(bufferSize);
  // The array shown by the explorer: the live buffer, or the frozen view while paused
  const logsRef = useRef<ParsedLog[]>([]);
  const rawCharsRef = useRef(0);
  const pausedRef = useRef(false);
  // Lines that arrived while paused, in order; they join the buffer on resume
  const heldRef = useRef<ParsedLog[]>([]);
  const heldCharsRef = useRef(0);
  const pendingRef = useRef<ParsedLog[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  bufferSizeRef.current = bufferSize;

  const addNotice = useCallback((notice: StreamNotice) => {
    setNotices((prev) => [...prev, notice].slice(-MAX_NOTICES));
  }, []);

  /** Memory estimate of everything retained: the shown array plus the lines held back while paused. */
  const publishBytes = useCallback(() => {
    const lines = logsRef.current.length + heldRef.current.length;
    const rawChars = rawCharsRef.current + heldCharsRef.current;
    setApproxBytes(lines * HEAP_BYTES_PER_LOG + rawChars * HEAP_BYTES_PER_RAW_CHAR);
  }, []);

  /** Appends `batch` to the buffer, keeping the newest `bufferSize` lines (Infinity = all) and counting the discarded ones. */
  const commit = useCallback((batch: ParsedLog[]) => {
    const prev = logsRef.current;
    const overflow = prev.length + batch.length - bufferSizeRef.current;
    if (overflow <= 0 && batch.length === 0) return;
    let rawChars = rawCharsRef.current;
    let next: ParsedLog[];
    if (overflow <= 0) {
      next = prev.concat(batch);
      for (const log of batch) rawChars += log.raw.length;
    } else {
      // Oldest lines go first; a batch bigger than the whole buffer loses its own oldest lines too
      const dropPrev = Math.min(overflow, prev.length);
      const dropBatch = overflow - dropPrev;
      const kept = dropBatch > 0 ? batch.slice(dropBatch) : batch;
      for (let i = 0; i < dropPrev; i++) rawChars -= prev[i].raw.length;
      for (const log of kept) rawChars += log.raw.length;
      const rest = dropPrev > 0 ? prev.slice(dropPrev) : prev;
      next = kept.length > 0 ? rest.concat(kept) : rest;
      setDropped((count) => count + overflow);
    }
    logsRef.current = next;
    rawCharsRef.current = rawChars;
    setLogs(next);
    publishBytes();
  }, [publishBytes]);

  /**
   * While paused the frozen view is never touched. The held lines are bounded to the buffer size instead: once they
   * exceed it by more than `slack` the oldest go in one chunk (down to the size), as in the live buffer, and count as dropped.
   */
  const trimPaused = useCallback((slack: number) => {
    const held = heldRef.current;
    const excess = held.length - bufferSizeRef.current;
    if (excess <= slack) return;
    let heldChars = heldCharsRef.current;
    for (let i = 0; i < excess; i++) heldChars -= held[i].raw.length;
    held.splice(0, excess);
    heldCharsRef.current = heldChars;
    setHeldCount(held.length);
    setDropped((count) => count + excess);
  }, []);

  /** Paused flush: only the new lines are touched, the frozen view is neither copied nor re-rendered. */
  const hold = useCallback((batch: ParsedLog[]) => {
    const held = heldRef.current;
    let heldChars = heldCharsRef.current;
    for (const log of batch) {
      held.push(log);
      heldChars += log.raw.length;
    }
    heldCharsRef.current = heldChars;
    setHeldCount(held.length);
    trimPaused(Math.max(MIN_PAUSED_SLACK, bufferSizeRef.current / PAUSED_SLACK_DIVISOR));
    publishBytes();
  }, [trimPaused, publishBytes]);

  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    setPaused(true);
  }, []);

  /** Leaves the pause: the held lines join the buffer. */
  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setPaused(false);
    const held = heldRef.current;
    heldRef.current = [];
    heldCharsRef.current = 0;
    setHeldCount(0);
    commit(held);
    publishBytes();
  }, [commit, publishBytes]);

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
    heldRef.current = [];
    heldCharsRef.current = 0;
    setLogs([]);
    setHeldCount(0);
    setApproxBytes(0);
    setDropped(0);
  }, [cancelFlush]);

  useEffect(() => {
    if (pausedRef.current) {
      trimPaused(0);
      publishBytes();
    } else {
      commit([]);
    }
  }, [bufferSize, commit, trimPaused, publishBytes]);

  useEffect(() => {
    let cancelled = false;

    const finishStream = () => {
      streamIdRef.current = null;
      activePodsRef.current.clear();
      setStreaming(false);
      resume();
    };

    const flush = () => {
      flushTimerRef.current = null;
      const batch = pendingRef.current;
      pendingRef.current = [];
      if (pausedRef.current) hold(batch);
      else commit(batch);
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
        const delay = Math.min(
          MAX_FLUSH_INTERVAL_MS,
          Math.max(MIN_FLUSH_INTERVAL_MS, logsRef.current.length / BUFFERED_LINES_PER_MS),
        );
        flushTimerRef.current = setTimeout(flush, delay);
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
  }, [addNotice, cancelFlush, commit, hold, resume]);

  const start = useCallback(async (options: StreamOptions) => {
    if (options.pods.length === 0) return;

    const id = newStreamId();
    streamIdRef.current = id;
    activePodsRef.current = new Set(options.pods);
    scopeRef.current = { namespace: options.namespace, container: options.container };
    pausedRef.current = false;
    setPaused(false);
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
    resume();
  }, [resume]);

  const clear = useCallback(() => {
    resetBuffer();
    setNotices([]);
  }, [resetBuffer]);

  return {
    logs,
    dropped,
    approxBytes,
    paused,
    heldCount,
    notices,
    connected,
    streaming,
    start,
    stop,
    clear,
    pause,
    resume,
  };
}
