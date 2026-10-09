import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import LogLine from './LogLine';
import type { ParsedLog } from '../types';

interface Props {
  logs: ParsedLog[];
  maxHeight: string;
  onSelect: (log: ParsedLog) => void;
  showRaw?: boolean;
  showPodName?: boolean;
  followTail?: boolean;
  empty?: ReactNode;
}

export default function VirtualLogList({
  logs,
  maxHeight,
  onSelect,
  showRaw = false,
  showPodName = false,
  followTail = false,
  empty = null,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const keys = useRef(new WeakMap<ParsedLog, number>());
  const nextKey = useRef(0);

  const getItemKey = useCallback(
    (index: number) => {
      const log = logs[index];
      let key = keys.current.get(log);
      if (key === undefined) {
        key = nextKey.current++;
        keys.current.set(log, key);
      }
      return key;
    },
    [logs],
  );

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (showRaw ? 80 : 28),
    getItemKey,
    overscan: 20,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [showRaw, virtualizer]);

  useEffect(() => {
    if (followTail && logs.length > 0) {
      virtualizer.scrollToIndex(logs.length - 1, { align: 'end' });
    }
  }, [logs, followTail, virtualizer]);

  return (
    <div ref={parentRef} className="klv-log-container" style={{ maxHeight, overflow: 'auto' }}>
      {logs.length > 0 ? (
        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <LogLine
                log={logs[virtualRow.index]}
                showRaw={showRaw}
                onClick={onSelect}
                showPodName={showPodName}
              />
            </div>
          ))}
        </div>
      ) : (
        empty
      )}
    </div>
  );
}
