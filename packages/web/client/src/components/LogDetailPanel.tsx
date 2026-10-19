import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { type ParsedLog } from '../types';
import type { ColumnId } from '../lib/columns';
import { fieldClause } from '../lib/query';
import { highlight } from '../lib/highlight';
import { formatTimestamp, levelConfig } from '../utils/log-utils';
import RawJsonView from './RawJsonView';
import { flattenExtra } from './explorer/clauses';
import { ArrowRightIcon, ColumnsIcon, CopyIcon, MinusIcon, PlusIcon, XIcon } from './explorer/icons';

interface FieldActions {
  /** Query field name (`service`, `@user.id`, …) used for include/exclude. */
  field?: string;
  value: string;
  filterable?: boolean;
  column?: ColumnId;
  trace?: 'trace' | 'span';
}

interface Props {
  log: ParsedLog | null;
  columns: ColumnId[];
  onClose: () => void;
  onFilter: (clause: string, mode: 'include' | 'exclude') => void;
  onToggleColumn: (id: ColumnId) => void;
  onOpenTrace: (kind: 'trace' | 'span', id: string) => void;
  onViewContext: (log: ParsedLog) => void;
  /** True while a stacked dialog (context view) is open, so Escape does not close this panel. */
  suspendKeys?: boolean;
  /** Opened from the context view: rendered above that dialog instead of above the page. */
  stacked?: boolean;
  /** Free-text terms to mark in message, error and stack trace. */
  highlight?: RegExp | null;
}

const iconButton =
  'w-5 h-5 flex items-center justify-center rounded text-klv-text-muted transition-colors';

export default function LogDetailPanel({
  log,
  columns,
  onClose,
  onFilter,
  onToggleColumn,
  onOpenTrace,
  onViewContext,
  suspendKeys = false,
  stacked = false,
  highlight: pattern = null,
}: Props) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);

  useEffect(() => {
    if (!log || suspendKeys) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [log, onClose, suspendKeys]);

  useEffect(() => {
    setCopied(null);
  }, [log]);

  const attributes = useMemo(() => (log ? flattenExtra(log.extra) : []), [log]);

  if (!log) return null;

  const cfg = levelConfig[log.level] ?? levelConfig.UNKNOWN;

  const copyRaw = () => {
    navigator.clipboard.writeText(log.raw).then(
      () => setCopied('ok'),
      () => setCopied('failed'),
    );
  };

  const renderActions = ({ field, value, filterable = true, column, trace }: FieldActions): ReactNode => {
    const canFilter = field !== undefined && filterable && value !== '';
    return (
      <span className="shrink-0 ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {canFilter && (
          <>
            <button
              type="button"
              title="Add to query"
              onClick={() => onFilter(fieldClause(field, value), 'include')}
              className={`${iconButton} hover:text-klv-accent hover:bg-klv-accent/10`}
            >
              <PlusIcon className="w-3 h-3" />
            </button>
            <button
              type="button"
              title="Exclude from query"
              onClick={() => onFilter(fieldClause(field, value), 'exclude')}
              className={`${iconButton} hover:text-red-600 hover:bg-red-50`}
            >
              <MinusIcon className="w-3 h-3" />
            </button>
          </>
        )}
        {column && (
          <button
            type="button"
            title={columns.includes(column) ? 'Remove column' : 'Add as column'}
            onClick={() => onToggleColumn(column)}
            className={`${iconButton} ${
              columns.includes(column) ? 'text-klv-accent' : ''
            } hover:text-klv-accent hover:bg-klv-accent/10`}
          >
            <ColumnsIcon className="w-3 h-3" />
          </button>
        )}
        {trace && (
          <button
            type="button"
            title={trace === 'trace' ? 'Search this trace' : 'Search this span'}
            onClick={() => onOpenTrace(trace, value)}
            className={`${iconButton} hover:text-klv-accent hover:bg-klv-accent/10`}
          >
            <ArrowRightIcon className="w-3 h-3" />
          </button>
        )}
      </span>
    );
  };

  const row = (
    label: string,
    actions: FieldActions,
    color = 'text-klv-text-secondary',
    labelColor = 'text-klv-text-muted',
    display?: ReactNode,
  ) =>
    actions.value ? (
      <div key={label} className="group flex items-start gap-3 py-1.5 border-b border-klv-border-subtle last:border-0">
        <span className={`${labelColor} shrink-0 w-24 text-right truncate`} title={label}>{label}</span>
        <span className={`${color} break-all min-w-0`}>{display ?? actions.value}</span>
        {renderActions(actions)}
      </div>
    ) : null;

  return (
    <>
      {/* Backdrop */}
      <div className={`fixed inset-0 bg-slate-900/30 ${stacked ? 'z-[70]' : 'z-40'} animate-fade-in`} onClick={onClose} />

      {/* Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-full sm:w-[540px] lg:w-[640px]
                    bg-klv-surface border-l border-klv-border ${stacked ? 'z-[80]' : 'z-50'}
                    animate-slide-in-right`}
      >
        <div className="h-full flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-klv-border">
            <div className="flex items-center gap-3 min-w-0">
              <span className={`klv-badge ${cfg.bg} ${cfg.color} font-semibold`}>{log.level}</span>
              <span className="text-xs text-klv-text-muted font-mono truncate">
                {formatTimestamp(log.k8sTimestamp ?? log.timestamp)}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onViewContext(log)}
                className="klv-btn text-xs !px-3 !py-1.5 bg-klv-accent/15 text-klv-accent border border-klv-accent/30 hover:bg-klv-accent/25"
              >
                View in context
              </button>
              <button
                type="button"
                onClick={copyRaw}
                className="klv-btn text-xs !px-3 !py-1.5 inline-flex items-center gap-1.5 bg-klv-elevated text-klv-text-secondary border border-klv-border hover:text-klv-text"
              >
                <CopyIcon />
                {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy raw'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="w-7 h-7 flex items-center justify-center rounded-md
                           text-klv-text-muted hover:text-klv-text hover:bg-klv-elevated
                           transition-colors"
                title="Close (Esc)"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-5 space-y-5">
            <section>
              <h3 className="klv-section-label mb-2">Fields</h3>
              <div className="klv-card p-3 font-mono text-xs">
                {row('level', { field: 'level', value: log.level, column: 'level' }, cfg.color)}
                {row('message', { value: log.message }, undefined, undefined, highlight(log.message, pattern))}
                {row('service', { field: 'service', value: log.service ?? '', column: 'service' }, 'text-sky-700')}
                {row('env', { field: 'env', value: log.env ?? '', column: 'env' })}
                {row('version', { field: 'version', value: log.version ?? '', column: 'version' })}
                {row('pod', { field: 'pod', value: log.podName ?? '', column: 'pod' }, 'text-violet-700')}
                {row('container', { field: 'container', value: log.container ?? '', column: 'container' })}
                {row('namespace', { field: 'namespace', value: log.namespace ?? '', column: 'namespace' })}
                {row('context', { value: log.context ?? '' })}
                {row('traceId', { field: 'trace', value: log.traceId ?? '', column: 'trace', trace: 'trace' })}
                {row('spanId', { field: 'span', value: log.spanId ?? '', trace: 'span' })}
                {row('caller', { field: 'caller', value: log.caller ?? '', column: 'caller' })}
                {row('error', { field: 'error', value: log.error ?? '' }, 'text-red-600', undefined, highlight(log.error ?? '', pattern))}
              </div>
            </section>

            {attributes.length > 0 && (
              <section>
                <h3 className="klv-section-label mb-2">Attributes</h3>
                <div className="klv-card p-3 font-mono text-xs">
                  {attributes.map((attr, i) => (
                    <div
                      key={`${attr.field}-${i}`}
                      className="group flex items-start gap-3 py-1.5 border-b border-klv-border-subtle last:border-0"
                    >
                      <span className="text-violet-700 shrink-0 max-w-[45%] break-all" title={attr.field}>
                        {attr.field}
                      </span>
                      <span className="text-klv-text-secondary break-all min-w-0">{attr.display}</span>
                      {renderActions({
                        field: attr.field,
                        value: attr.display,
                        filterable: attr.filterable,
                        column: attr.field as ColumnId,
                      })}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {log.stackTrace && (
              <section>
                <h3 className="klv-section-label mb-2">Stack Trace</h3>
                <pre className="text-xs text-red-700 font-mono bg-red-50 border border-red-200
                                rounded-lg p-4 overflow-auto whitespace-pre-wrap">
                  {highlight(log.stackTrace, pattern)}
                </pre>
              </section>
            )}

            <section>
              <h3 className="klv-section-label mb-2">
                Raw
                {log.isJson && (
                  <span className="ml-2 normal-case tracking-normal font-normal">· click a key or value to filter</span>
                )}
              </h3>
              <RawJsonView log={log} columns={columns} onFilter={onFilter} onToggleColumn={onToggleColumn} />
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
