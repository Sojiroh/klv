import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TIME_RANGES, type TimeRangeState } from '../lib/time';
import { DEFAULT_COLUMNS, isColumnId, parseColumns, serializeColumns, type ColumnId } from '../lib/columns';
import { usePersistentState } from './usePersistentState';

export const TAIL_OPTIONS = [100, 500, 1000, 5000, 10000];
export const DEFAULT_TAIL = 1000;

export type ExplorerView = 'logs' | 'patterns';

export interface ExplorerParams {
  query: string;
  setQuery: (query: string) => void;
  range: TimeRangeState;
  setRange: (range: TimeRangeState) => void;
  tail: number;
  setTail: (tail: number) => void;
  previous: boolean;
  setPrevious: (previous: boolean) => void;
  view: ExplorerView;
  setView: (view: ExplorerView) => void;
  pattern: string | null;
  setPattern: (id: string | null) => void;
  columns: ColumnId[];
  setColumns: (columns: ColumnId[]) => void;
  groupBy: ColumnId;
  setGroupBy: (id: ColumnId) => void;
  searchParams: URLSearchParams;
  /** Sets (string) or removes (null / empty) URL parameters in one history-replacing navigation. */
  update: (patch: Record<string, string | null>) => void;
}

/** Shareable explorer state kept in the URL: q, range, from, to, tail, previous, view, pattern, cols, by. */
export function useExplorerParams(defaultRange: string): ExplorerParams {
  const [searchParams, setSearchParams] = useSearchParams();
  const latest = useRef(searchParams);
  latest.current = searchParams;
  const navigate = useRef(setSearchParams);
  navigate.current = setSearchParams;
  const [storedColumns, setStoredColumns] = usePersistentState<ColumnId[]>('klv.explorer.columns', DEFAULT_COLUMNS);

  const update = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(latest.current);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    latest.current = next;
    navigate.current(next, { replace: true });
  }, []);

  const query = searchParams.get('q') ?? '';
  const rangeParam = searchParams.get('range');
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  const tailParam = searchParams.get('tail');
  const colsParam = searchParams.get('cols');
  const byParam = searchParams.get('by');
  const groupBy: ColumnId = byParam && isColumnId(byParam) && byParam !== 'time' && byParam !== 'message' ? byParam : 'level';

  const range = useMemo<TimeRangeState>(() => {
    if (rangeParam === 'custom') {
      const from = Number(fromParam);
      const to = Number(toParam);
      if (fromParam && toParam && Number.isFinite(from) && Number.isFinite(to) && from < to) {
        return { range: 'custom', from, to };
      }
    } else if (TIME_RANGES.some((r) => r.id === rangeParam)) {
      return { range: rangeParam as string };
    }
    return { range: defaultRange };
  }, [rangeParam, fromParam, toParam, defaultRange]);

  const tail = TAIL_OPTIONS.includes(Number(tailParam)) ? Number(tailParam) : DEFAULT_TAIL;

  const columns = useMemo(
    () => parseColumns(colsParam ?? serializeColumns(storedColumns)),
    [colsParam, storedColumns],
  );

  const setQuery = useCallback((q: string) => update({ q: q.trim() === '' ? null : q }), [update]);

  const setRange = useCallback(
    (next: TimeRangeState) => {
      if (next.range === 'custom' && next.from !== undefined && next.to !== undefined) {
        update({ range: 'custom', from: String(Math.round(next.from)), to: String(Math.round(next.to)) });
      } else {
        update({ range: next.range === defaultRange ? null : next.range, from: null, to: null });
      }
    },
    [update, defaultRange],
  );

  const setTail = useCallback(
    (next: number) => update({ tail: next === DEFAULT_TAIL ? null : String(next) }),
    [update],
  );
  const setPrevious = useCallback((next: boolean) => update({ previous: next ? 'true' : null }), [update]);
  const setView = useCallback((next: ExplorerView) => update({ view: next === 'patterns' ? 'patterns' : null }), [update]);
  const setPattern = useCallback((id: string | null) => update({ pattern: id }), [update]);
  const setGroupBy = useCallback((id: ColumnId) => update({ by: id === 'level' ? null : id }), [update]);
  const setColumns = useCallback(
    (next: ColumnId[]) => {
      setStoredColumns(next);
      update({ cols: serializeColumns(next) });
    },
    [setStoredColumns, update],
  );

  return {
    query,
    setQuery,
    range,
    setRange,
    tail,
    setTail,
    previous: searchParams.get('previous') === 'true',
    setPrevious,
    view: searchParams.get('view') === 'patterns' ? 'patterns' : 'logs',
    setView,
    pattern: searchParams.get('pattern') || null,
    setPattern,
    columns,
    setColumns,
    groupBy,
    setGroupBy,
    searchParams,
    update,
  };
}
