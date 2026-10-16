import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { columnLabel, columnValue, type ColumnId } from '../../lib/columns';
import type { ParsedLog } from '../../types';
import { formatMs, levelConfig, prettyRaw } from '../../utils/log-utils';
import { cachedTime } from './pipeline';
import { XIcon } from './icons';

const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 28;
const RAW_ROW_HEIGHT = 80;
const GAP = 12;
const PADDING_X = 12;
const MESSAGE_MIN_WIDTH = 320;

const FIXED_WIDTHS: Record<string, number> = {
  level: 68,
  pod: 180,
  container: 120,
  namespace: 110,
  service: 120,
  env: 90,
  version: 110,
  trace: 150,
  caller: 160,
};
const ATTRIBUTE_WIDTH = 150;

function columnWidth(id: ColumnId, showDate: boolean): number {
  if (id === 'time') return showDate ? 148 : 92;
  return FIXED_WIDTHS[id] ?? ATTRIBUTE_WIDTH;
}

function cellColor(id: ColumnId): string {
  if (id === 'pod') return 'text-violet-700';
  if (id === 'service') return 'text-sky-700';
  if (id === 'time') return 'text-klv-text-muted';
  return 'text-klv-text-secondary';
}

interface Props {
  logs: ParsedLog[];
  columns: ColumnId[];
  maxHeight: string;
  onSelect?: (log: ParsedLog) => void;
  selected?: ParsedLog | null;
  showRaw?: boolean;
  followTail?: boolean;
  /** Scrolls this row to the centre whenever it (or the logs) change. */
  scrollToIndex?: number | null;
  onRemoveColumn?: (id: ColumnId) => void;
  empty?: ReactNode;
}

function Cell({ log, id, showDate }: { log: ParsedLog; id: ColumnId; showDate: boolean }) {
  if (id === 'time') {
    return <span className="text-klv-text-muted tabular-nums truncate">{formatMs(cachedTime(log), showDate)}</span>;
  }
  if (id === 'level') {
    const cfg = levelConfig[log.level] ?? levelConfig.UNKNOWN;
    return (
      <span className={`inline-flex items-center gap-1 ${cfg.color}`}>
        <span className="text-[10px]">{cfg.icon}</span>
        <span>{log.level}</span>
      </span>
    );
  }
  if (id === 'message') {
    const isError = log.level === 'ERROR' || log.level === 'FATAL';
    return (
      <span
        className={`truncate transition-colors ${isError ? 'text-red-600' : 'text-klv-text-secondary group-hover:text-klv-text'}`}
      >
        {log.message}
      </span>
    );
  }
  const value = columnValue(log, id);
  return (
    <span className={`truncate ${cellColor(id)}`} title={value}>
      {value}
    </span>
  );
}

export default function LogTable({
  logs,
  columns,
  maxHeight,
  onSelect,
  selected = null,
  showRaw = false,
  followTail = false,
  scrollToIndex = null,
  onRemoveColumn,
  empty = null,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const keys = useRef(new WeakMap<ParsedLog, number>());
  const nextKey = useRef(0);
  const [active, setActive] = useState(-1);

  const showDate = useMemo(() => {
    if (logs.length === 0) return false;
    const first = cachedTime(logs[0]);
    const last = cachedTime(logs[logs.length - 1]);
    return first !== null && last !== null && new Date(first).toDateString() !== new Date(last).toDateString();
  }, [logs]);

  const { template, minWidth } = useMemo(() => {
    const widths = columns.map((id) => (id === 'message' ? MESSAGE_MIN_WIDTH : columnWidth(id, showDate)));
    return {
      template: columns
        .map((id, i) => (id === 'message' ? `minmax(${widths[i]}px, 1fr)` : `${widths[i]}px`))
        .join(' '),
      minWidth: widths.reduce((a, b) => a + b, 0) + GAP * (columns.length - 1) + PADDING_X * 2,
    };
  }, [columns, showDate]);

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

  const headerHeight = showRaw ? 0 : HEADER_HEIGHT;

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (showRaw ? RAW_ROW_HEIGHT : ROW_HEIGHT),
    getItemKey,
    overscan: 20,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [showRaw, virtualizer]);

  useEffect(() => {
    if (followTail && logs.length > 0) {
      virtualizer.scrollToIndex(logs.length - 1, { align: 'end' });
    }
  }, [logs, followTail, virtualizer]);

  useEffect(() => {
    if (scrollToIndex !== null && scrollToIndex >= 0 && scrollToIndex < logs.length) {
      virtualizer.scrollToIndex(scrollToIndex, { align: 'center' });
    }
  }, [scrollToIndex, logs, virtualizer]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (logs.length === 0) return;
    const current = Math.min(active, logs.length - 1);
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        next = Math.min(logs.length - 1, current + 1);
        break;
      case 'ArrowUp':
      case 'k':
        next = Math.max(0, current - 1);
        break;
      case 'PageDown':
        next = Math.min(logs.length - 1, current + 15);
        break;
      case 'PageUp':
        next = Math.max(0, current - 15);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = logs.length - 1;
        break;
      case 'Enter':
        if (current >= 0) onSelect?.(logs[current]);
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    setActive(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  return (
    <div
      ref={parentRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="klv-log-container !p-0 focus:outline-none focus-visible:border-klv-accent/40"
      style={{ maxHeight, overflow: 'auto' }}
    >
      {logs.length > 0 ? (
        <div style={{ minWidth: showRaw ? undefined : minWidth, position: 'relative' }}>
          {!showRaw && (
            <div
              className="sticky top-0 z-10 grid items-center bg-klv-surface border-b border-klv-border font-body"
              style={{ gridTemplateColumns: template, columnGap: GAP, height: HEADER_HEIGHT, padding: `0 ${PADDING_X}px` }}
            >
              {columns.map((id) => (
                <span key={id} className="group/head flex items-center gap-1 min-w-0 klv-section-label">
                  <span className="truncate" title={id}>{columnLabel(id)}</span>
                  {onRemoveColumn && id !== 'message' && (
                    <button
                      type="button"
                      onClick={() => onRemoveColumn(id)}
                      title={`Remove ${columnLabel(id)} column`}
                      className="opacity-0 group-hover/head:opacity-100 text-klv-text-muted hover:text-red-600 transition-opacity"
                    >
                      <XIcon className="w-2.5 h-2.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const log = logs[row.index];
              const isSelected = selected === log;
              const isActive = row.index === active;
              const stateClass = isSelected
                ? 'border-klv-accent bg-klv-accent/10'
                : isActive
                  ? 'border-klv-accent/40 bg-klv-accent/5'
                  : 'border-transparent hover:border-klv-accent/40 hover:bg-klv-elevated/40';
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${row.start - headerHeight}px)`,
                  }}
                >
                  {showRaw ? (
                    <pre
                      className={`text-xs text-klv-text-secondary font-mono whitespace-pre-wrap px-3 py-1 border-l-2 cursor-pointer transition-colors duration-100 ${stateClass}`}
                      onClick={() => {
                        setActive(row.index);
                        onSelect?.(log);
                      }}
                    >
                      {log.isJson ? prettyRaw(log.raw) : log.raw}
                    </pre>
                  ) : (
                    <div
                      className={`group grid items-center font-mono text-xs border-l-2 transition-colors duration-100 ${
                        onSelect ? 'cursor-pointer' : ''
                      } ${stateClass}`}
                      style={{
                        gridTemplateColumns: template,
                        columnGap: GAP,
                        height: ROW_HEIGHT,
                        padding: `0 ${PADDING_X - 2}px 0 ${PADDING_X - 2}px`,
                      }}
                      onClick={() => {
                        setActive(row.index);
                        onSelect?.(log);
                      }}
                    >
                      {columns.map((id) => (
                        <Cell key={id} log={log} id={id} showDate={showDate} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        empty
      )}
    </div>
  );
}
