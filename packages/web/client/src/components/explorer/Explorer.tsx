import { useCallback, useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { ExplorerParams } from '../../hooks/useExplorerParams';
import { computeFacets } from '../../lib/facets';
import { buildHistogram } from '../../lib/histogram';
import { computePatterns, messageSignature } from '../../lib/patterns';
import { fieldClause, parseQuery, toggleClause } from '../../lib/query';
import { resolveRange } from '../../lib/time';
import type { ColumnId } from '../../lib/columns';
import type { ParsedLog } from '../../types';
import LogDetailPanel from '../LogDetailPanel';
import ColumnsPicker from './ColumnsPicker';
import ContextView, { type ContextScope } from './ContextView';
import ExportMenu from './ExportMenu';
import FacetsPanel from './FacetsPanel';
import Histogram from './Histogram';
import LogTable from './LogTable';
import PatternsTable from './PatternsTable';
import QueryBar from './QueryBar';
import TimeRangePicker from './TimeRangePicker';
import ToolbarToggle from './ToolbarToggle';
import { withColumn, withoutColumn } from './clauses';
import { FilterIcon, XIcon } from './icons';
import { filterPattern, filterQuery, filterWindow, timeSpan } from './pipeline';

const TABLE_HEIGHT = 'max(320px, calc(100vh - 440px))';

interface Props {
  params: ExplorerParams;
  /** `kubelet`: client-side query over loaded data. `history`: the server already applied the query. */
  source: 'kubelet' | 'history';
  logs: ParsedLog[];
  /** Reference "now" for relative ranges (the moment the data was requested). Required when `showRange`. */
  loadedAt?: number;
  loading?: boolean;
  scope: ContextScope;
  showRange?: boolean;
  followTail?: boolean;
  /** Page-specific controls rendered in the toolbar row. */
  toolbar?: ReactNode;
  /** Warnings rendered between the toolbar and the results. */
  notices?: ReactNode;
  emptyMessage?: ReactNode;
  exportName: string;
  onLogSelect?: (log: ParsedLog) => void;
  maxHeight?: string;
}

export default function Explorer({
  params,
  source,
  logs,
  loadedAt = 0,
  loading = false,
  scope,
  showRange = true,
  followTail = false,
  toolbar,
  notices,
  emptyMessage = 'No logs',
  exportName,
  onLogSelect,
  maxHeight = TABLE_HEIGHT,
}: Props) {
  const navigate = useNavigate();
  const { query, setQuery, range, setRange, view, pattern, columns, setColumns, setPattern } = params;
  const [selected, setSelected] = useState<ParsedLog | null>(null);
  const [contextLog, setContextLog] = useState<ParsedLog | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [facetsOpen, setFacetsOpen] = usePersistentState('klv.explorer.facets', true);

  const { context, namespace, container, previous } = scope;
  const contextScope = useMemo(() => ({ context, namespace, container, previous }), [context, namespace, container, previous]);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const ast = parsed.ok ? parsed.ast : null;

  const timeWindow = useMemo(() => (showRange ? resolveRange(range, loadedAt) : null), [showRange, range, loadedAt]);
  const windowed = useMemo(
    () => (timeWindow ? filterWindow(logs, timeWindow.from, timeWindow.to) : logs),
    [logs, timeWindow],
  );
  const queried = useMemo(() => (source === 'history' ? windowed : filterQuery(windowed, ast)), [source, windowed, ast]);
  const shown = useMemo(() => filterPattern(queried, pattern), [queried, pattern]);

  // Facets, patterns and the histogram are the expensive parts: let a fast-growing live buffer render first.
  const analysed = useDeferredValue(queried);
  const analysedShown = useDeferredValue(shown);

  const facets = useMemo(() => computeFacets(analysed), [analysed]);
  const patterns = useMemo(() => (view === 'patterns' ? computePatterns(analysed) : []), [view, analysed]);

  const histogram = useMemo(() => {
    const span = timeWindow ?? timeSpan(analysedShown);
    const bounds = span ? { from: span.from, to: Math.max(span.to, span.from + 1000) } : { from: 0, to: 1000 };
    return buildHistogram(analysedShown, bounds);
  }, [timeWindow, analysedShown]);

  const applyClause = useCallback(
    (clause: string, mode: 'include' | 'exclude') => setQuery(toggleClause(query, clause, mode)),
    [query, setQuery],
  );

  const toggleColumn = (id: ColumnId) => setColumns(columns.includes(id) ? withoutColumn(columns, id) : withColumn(columns, id));

  const openTrace = (kind: 'trace' | 'span', id: string) => {
    const next = new URLSearchParams({ q: fieldClause(kind, id) });
    for (const key of ['range', 'from', 'to']) {
      const value = params.searchParams.get(key);
      if (value) next.set(key, value);
    }
    const ns = selected?.namespace ?? namespace;
    if (ns) next.set('ns', ns);
    if (source === 'history') {
      const ctx = selected?.context ?? context;
      if (ctx) next.set('ctx', ctx);
    }
    setSelected(null);
    navigate(`${source === 'history' ? '/history' : '/search'}?${next}`);
  };

  const select = (log: ParsedLog) => {
    onLogSelect?.(log);
    setSelected(log);
  };

  const patternLabel = useMemo(() => {
    if (!pattern) return null;
    const sample = shown[0];
    return sample ? messageSignature(sample.message) : `pattern ${pattern}`;
  }, [pattern, shown]);

  const filtered = shown.length !== logs.length;

  const emptyNode = loading ? (
    <p className="py-12 text-center text-sm text-klv-text-muted animate-pulse">Loading logs…</p>
  ) : logs.length === 0 ? (
    <div className="py-10 text-center text-sm text-klv-text-muted">{emptyMessage}</div>
  ) : (
    <div className="py-10 text-center text-sm text-klv-text-muted space-y-2">
      <p>No logs match the current filters</p>
      <button
        type="button"
        className="text-klv-accent hover:text-klv-accent-hover text-xs"
        onClick={() => {
          params.update({ q: null, pattern: null });
        }}
      >
        Clear query and pattern
      </button>
    </div>
  );

  return (
    <>
      <div className="space-y-3">
        {/* Query + range */}
        <div className="flex flex-wrap items-start gap-3">
          <QueryBar value={query} onApply={setQuery} />
          {showRange && <TimeRangePicker value={range} now={loadedAt} onChange={setRange} />}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-klv-border bg-klv-elevated p-0.5">
            {(['logs', 'patterns'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => params.setView(v)}
                className={`px-3 py-1 text-xs font-medium rounded-md capitalize transition-colors ${
                  view === v ? 'bg-klv-accent/15 text-klv-accent' : 'text-klv-text-muted hover:text-klv-text'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <span className="text-xs font-mono text-klv-text-muted tabular-nums px-1">
            <span className="text-klv-text-secondary">{shown.length.toLocaleString()}</span>
            {filtered && <> / {logs.length.toLocaleString()}</>} logs
          </span>

          {patternLabel && (
            <span className="inline-flex items-center gap-1.5 max-w-[420px] pl-2.5 pr-1.5 py-0.5 rounded-md text-xs font-mono bg-klv-accent/10 text-klv-accent border border-klv-accent/30">
              <span className="klv-section-label !text-klv-accent/70">pattern</span>
              <span className="truncate">{patternLabel}</span>
              <button
                type="button"
                onClick={() => setPattern(null)}
                title="Clear pattern filter"
                className="hover:text-white transition-colors"
              >
                <XIcon className="w-3 h-3" />
              </button>
            </span>
          )}

          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {toolbar}
            <ToolbarToggle active={facetsOpen} onClick={() => setFacetsOpen(!facetsOpen)}>
              <FilterIcon />
              Facets
            </ToolbarToggle>
            <ColumnsPicker columns={columns} facets={facets} onChange={setColumns} />
            <ToolbarToggle active={showRaw} onClick={() => setShowRaw(!showRaw)}>
              <span className="font-mono">{'{}'}</span> Raw
            </ToolbarToggle>
            <ExportMenu logs={shown} columns={columns} name={exportName} />
          </div>
        </div>

        {/* Histogram */}
        <div className="klv-card px-3 pt-2 pb-1">
          <Histogram histogram={histogram} onZoom={showRange ? (from, to) => setRange({ range: 'custom', from, to }) : undefined} />
        </div>

        {notices}

        {/* Results */}
        <div className="flex items-start gap-4">
          {facetsOpen && (
            <aside className="w-60 shrink-0 hidden md:block">
              <FacetsPanel facets={facets} query={query} maxHeight={maxHeight} onToggle={applyClause} />
            </aside>
          )}
          <section className="flex-1 min-w-0">
            {view === 'patterns' ? (
              <PatternsTable
                patterns={patterns}
                total={analysed.length}
                active={pattern}
                maxHeight={maxHeight}
                onSelect={(id) => params.update({ pattern: id, view: id ? null : 'patterns' })}
              />
            ) : (
              <LogTable
                logs={shown}
                columns={columns}
                maxHeight={maxHeight}
                showRaw={showRaw}
                followTail={followTail}
                selected={selected}
                onSelect={select}
                onRemoveColumn={(id) => setColumns(withoutColumn(columns, id))}
                empty={emptyNode}
              />
            )}
          </section>
        </div>
      </div>

      <LogDetailPanel
        log={selected}
        columns={columns}
        suspendKeys={contextLog !== null}
        onClose={() => setSelected(null)}
        onFilter={applyClause}
        onToggleColumn={toggleColumn}
        onOpenTrace={openTrace}
        onViewContext={setContextLog}
      />

      {contextLog && (
        <ContextView log={contextLog} source={source} scope={contextScope} onClose={() => setContextLog(null)} />
      )}
    </>
  );
}
