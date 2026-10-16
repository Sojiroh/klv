import { Fragment, useEffect, useMemo, useState } from 'react';
import { useApi } from '../../hooks/useApi';
import { useHistoryStatus } from '../../hooks/useHistoryStatus';
import { apiRequest, errorMessage } from '../../lib/api';
import type {
  CollectorStatus,
  CollectorStream,
  ContextsResponse,
  HistoryConfig,
  HistoryConfigInput,
  LogLevel,
} from '../../types';
import { formatBytes, formatTimestamp } from '../../utils/log-utils';
import ErrorNotice from '../ErrorNotice';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon } from '../explorer/icons';

const MAX_TARGETS = 50;
const MAX_SELECTOR_LENGTH = 1024;
const AGE_BOUNDS = { min: 1, max: 365 };
const SIZE_BOUNDS = { min: 64, max: 102400 };
const MAX_EXCLUDES = 20;
const MAX_EXCLUDE_LENGTH = 200;
const MIN_LEVELS: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

interface DraftTarget {
  key: string;
  id?: string;
  context: string;
  namespace: string;
  container: string;
  labelSelector: string;
  enabled: boolean;
  minLevel?: LogLevel;
  exclude: string;
}

interface Draft {
  targets: DraftTarget[];
  maxAgeDays: string;
  maxSizeMb: string;
}

let nextKey = 0;
const newKey = () => `target-${nextKey++}`;

// Patrones separados por coma → arreglo recortado sin vacíos (undefined si no queda ninguno).
function parseExclude(text: string): string[] | undefined {
  const patterns = text.split(',').map((p) => p.trim()).filter(Boolean);
  return patterns.length > 0 ? patterns : undefined;
}

function toDraft(config: HistoryConfig): Draft {
  return {
    targets: config.targets.map((t) => ({
      key: newKey(),
      id: t.id,
      context: t.context,
      namespace: t.namespace,
      container: t.container ?? '',
      labelSelector: t.labelSelector ?? '',
      enabled: t.enabled,
      minLevel: t.minLevel,
      exclude: (t.exclude ?? []).join(', '),
    })),
    maxAgeDays: String(config.retention.maxAgeDays),
    maxSizeMb: String(config.retention.maxSizeMb),
  };
}

function toInput(draft: Draft): HistoryConfigInput {
  return {
    targets: draft.targets.map((t) => ({
      id: t.id,
      context: t.context.trim(),
      namespace: t.namespace.trim(),
      container: t.container.trim() || undefined,
      labelSelector: t.labelSelector.trim() || undefined,
      enabled: t.enabled,
      minLevel: t.minLevel,
      exclude: parseExclude(t.exclude),
    })),
    retention: { maxAgeDays: Number(draft.maxAgeDays), maxSizeMb: Number(draft.maxSizeMb) },
  };
}

function validate(input: HistoryConfigInput): string | null {
  if (input.targets.length > MAX_TARGETS) return `At most ${MAX_TARGETS} targets are allowed`;
  for (const [i, t] of input.targets.entries()) {
    if (!t.context) return `Target ${i + 1}: choose a context`;
    if (!t.namespace) return `Target ${i + 1}: namespace is required`;
    if ((t.labelSelector?.length ?? 0) > MAX_SELECTOR_LENGTH) {
      return `Target ${i + 1}: label selector is longer than ${MAX_SELECTOR_LENGTH} characters`;
    }
    if ((t.exclude?.length ?? 0) > MAX_EXCLUDES) {
      return `Target ${i + 1}: at most ${MAX_EXCLUDES} exclude patterns are allowed`;
    }
    if (t.exclude?.some((p) => p.length > MAX_EXCLUDE_LENGTH)) {
      return `Target ${i + 1}: exclude patterns are limited to ${MAX_EXCLUDE_LENGTH} characters`;
    }
  }
  const { maxAgeDays, maxSizeMb } = input.retention;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < AGE_BOUNDS.min || maxAgeDays > AGE_BOUNDS.max) {
    return `Max age must be a whole number between ${AGE_BOUNDS.min} and ${AGE_BOUNDS.max} days`;
  }
  if (!Number.isInteger(maxSizeMb) || maxSizeMb < SIZE_BOUNDS.min || maxSizeMb > SIZE_BOUNDS.max) {
    return `Max size must be a whole number between ${SIZE_BOUNDS.min} and ${SIZE_BOUNDS.max} MB`;
  }
  return null;
}

const stateStyles: Record<string, string> = {
  running: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  following: 'text-emerald-600 bg-emerald-50 border-emerald-200',
  waiting: 'text-amber-700 bg-amber-50 border-amber-200',
  error: 'text-red-600 bg-red-50 border-red-200',
  disabled: 'text-slate-500 bg-slate-100 border-slate-200',
};

function StateBadge({ state }: { state: string }) {
  return (
    <span className={`klv-badge border text-[10px] uppercase tracking-wide ${stateStyles[state] ?? stateStyles.disabled}`}>
      {state}
    </span>
  );
}

function Streams({ streams }: { streams: CollectorStream[] }) {
  if (streams.length === 0) return <p className="text-xs text-klv-text-muted py-1">No streams yet</p>;
  return (
    <table className="w-full text-xs font-mono">
      <thead>
        <tr className="text-left klv-section-label">
          <th className="py-1 pr-4 font-semibold">Pod</th>
          <th className="py-1 pr-4 font-semibold">Container</th>
          <th className="py-1 pr-4 font-semibold">State</th>
          <th className="py-1 pr-4 font-semibold">Last line</th>
          <th className="py-1 font-semibold">Error</th>
        </tr>
      </thead>
      <tbody>
        {streams.map((s) => (
          <tr key={`${s.pod}/${s.container}`} className="border-t border-klv-border-subtle">
            <td className="py-1 pr-4 text-violet-700 break-all">{s.pod}</td>
            <td className="py-1 pr-4 text-klv-text-secondary">{s.container}</td>
            <td className="py-1 pr-4"><StateBadge state={s.state} /></td>
            <td className="py-1 pr-4 text-klv-text-muted">{s.lastLineAt ? formatTimestamp(s.lastLineAt) : '--'}</td>
            <td className="py-1 text-red-600 break-all">{s.error}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const cellInput = 'klv-input w-full !py-1 text-xs font-mono';

export default function CollectorPanel() {
  const { status, error: statusError, refresh } = useHistoryStatus();
  const { data: contexts } = useApi<ContextsResponse>('/api/contexts');
  const { data: namespaces } = useApi<string[]>('/api/namespaces');

  const [config, setConfig] = useState<HistoryConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<HistoryConfig>('/api/history/config', { signal: controller.signal }).then(
      (loaded) => {
        if (controller.signal.aborted) return;
        setConfig(loaded);
        setDraft(toDraft(loaded));
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(err));
      },
    );
    return () => controller.abort();
  }, []);

  const input = useMemo(() => (draft ? toInput(draft) : null), [draft]);
  const validation = input ? validate(input) : null;
  const dirty = useMemo(
    () => !!input && !!config && JSON.stringify(input) !== JSON.stringify(toInput(toDraft(config))),
    [input, config],
  );

  const statusByTarget = useMemo(() => {
    const map: Record<string, CollectorStatus> = {};
    for (const c of status?.collectors ?? []) map[c.targetId] = c;
    return map;
  }, [status]);

  const patchTarget = (key: string, patch: Partial<DraftTarget>) =>
    setDraft((d) => d && { ...d, targets: d.targets.map((t) => (t.key === key ? { ...t, ...patch } : t)) });

  const addTarget = () =>
    setDraft(
      (d) =>
        d && {
          ...d,
          targets: [
            ...d.targets,
            {
              key: newKey(),
              context: contexts?.current ?? '',
              namespace: '',
              container: '',
              labelSelector: '',
              enabled: true,
              exclude: '',
            },
          ],
        },
    );

  const save = async () => {
    if (!input || validation) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await apiRequest<HistoryConfig>('/api/history/config', { method: 'PUT', body: input });
      setConfig(saved);
      setDraft(toDraft(saved));
      void refresh();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const clearHistory = async () => {
    setClearing(true);
    setClearError(null);
    try {
      await apiRequest<unknown>('/api/history/clear', { method: 'POST', body: {} });
      setConfirmClear(false);
      void refresh();
    } catch (err) {
      setClearError(errorMessage(err));
    } finally {
      setClearing(false);
    }
  };

  const error = loadError ?? statusError;

  return (
    <div className="space-y-5">
      {error && <ErrorNotice message={error} />}

      {/* Targets */}
      <section className="klv-card overflow-hidden animate-slide-up">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-klv-border">
          <div>
            <h3 className="font-display font-bold tracking-tight">Collector targets</h3>
            <p className="text-xs text-klv-text-muted mt-0.5">
              Every enabled target is followed continuously and stored locally.
            </p>
          </div>
          <button type="button" onClick={addTarget} disabled={!draft} className="klv-btn-secondary !px-3 !py-1.5 text-xs inline-flex items-center gap-1.5">
            <PlusIcon /> Add target
          </button>
        </div>

        {!draft && !loadError && <p className="px-5 py-8 text-center text-sm text-klv-text-muted animate-pulse">Loading…</p>}

        {draft && draft.targets.length === 0 && (
          <p className="px-5 py-8 text-center text-sm text-klv-text-muted">
            No targets yet. Add one to start recording logs.
          </p>
        )}

        {draft && draft.targets.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b border-klv-border bg-klv-surface">
                  <th className="py-2.5 px-3 w-8" />
                  <th className="py-2.5 px-3 text-left klv-section-label w-16">On</th>
                  <th className="py-2.5 px-3 text-left klv-section-label">Context</th>
                  <th className="py-2.5 px-3 text-left klv-section-label">Namespace</th>
                  <th className="py-2.5 px-3 text-left klv-section-label">Container</th>
                  <th className="py-2.5 px-3 text-left klv-section-label">Label selector</th>
                  <th className="py-2.5 px-3 text-left klv-section-label">Min level</th>
                  <th className="py-2.5 px-3 text-left klv-section-label">Exclude</th>
                  <th className="py-2.5 px-3 text-left klv-section-label">Status</th>
                  <th className="py-2.5 px-3 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-klv-border-subtle">
                {draft.targets.map((t) => {
                  const live = t.id ? statusByTarget[t.id] : undefined;
                  const open = !!expanded[t.key];
                  const following = live?.streams.filter((s) => s.state === 'following').length ?? 0;
                  return (
                    <Fragment key={t.key}>
                      <tr className="hover:bg-klv-surface/50 align-top">
                        <td className="py-2 px-3">
                          <button
                            type="button"
                            disabled={!live}
                            onClick={() => setExpanded((e) => ({ ...e, [t.key]: !open }))}
                            title="Show streams"
                            className="w-6 h-6 flex items-center justify-center rounded text-klv-text-muted hover:text-klv-text hover:bg-klv-elevated disabled:opacity-40"
                          >
                            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                          </button>
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="checkbox"
                            checked={t.enabled}
                            onChange={(e) => patchTarget(t.key, { enabled: e.target.checked })}
                            className="accent-klv-accent mt-2"
                            aria-label="Enabled"
                          />
                        </td>
                        <td className="py-2 px-3 min-w-[160px]">
                          <select
                            value={t.context}
                            onChange={(e) => patchTarget(t.key, { context: e.target.value })}
                            className="klv-select w-full !py-1 text-xs font-mono"
                          >
                            {!contexts?.contexts.includes(t.context) && <option value={t.context}>{t.context || 'Select…'}</option>}
                            {contexts?.contexts.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 px-3 min-w-[140px]">
                          <input
                            type="text"
                            list="collector-namespaces"
                            value={t.namespace}
                            onChange={(e) => patchTarget(t.key, { namespace: e.target.value })}
                            placeholder="namespace"
                            className={cellInput}
                          />
                        </td>
                        <td className="py-2 px-3 min-w-[130px]">
                          <input
                            type="text"
                            value={t.container}
                            onChange={(e) => patchTarget(t.key, { container: e.target.value })}
                            placeholder="all containers"
                            className={cellInput}
                          />
                        </td>
                        <td className="py-2 px-3 min-w-[180px]">
                          <input
                            type="text"
                            value={t.labelSelector}
                            onChange={(e) => patchTarget(t.key, { labelSelector: e.target.value })}
                            placeholder="app=api,tier!=db"
                            className={cellInput}
                          />
                        </td>
                        <td className="py-2 px-3 min-w-[110px]">
                          <select
                            value={t.minLevel ?? ''}
                            onChange={(e) => patchTarget(t.key, { minLevel: (e.target.value || undefined) as LogLevel | undefined })}
                            className="klv-select w-full !py-1 text-xs font-mono"
                            aria-label="Min level"
                          >
                            <option value="">All</option>
                            {MIN_LEVELS.map((l) => (
                              <option key={l} value={l}>{l}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 px-3 min-w-[170px]">
                          <input
                            type="text"
                            value={t.exclude}
                            onChange={(e) => patchTarget(t.key, { exclude: e.target.value })}
                            placeholder="healthz, /metrics"
                            className={cellInput}
                          />
                        </td>
                        <td className="py-2 px-3 min-w-[150px]">
                          {live ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <StateBadge state={live.state} />
                                <span className="text-[11px] font-mono text-klv-text-muted">
                                  {following}/{live.streams.length} streams
                                </span>
                              </div>
                              {live.error && <p className="text-[11px] text-red-600 font-mono break-all">{live.error}</p>}
                            </div>
                          ) : (
                            <span className="text-[11px] text-klv-text-muted">{t.id ? '--' : 'Unsaved'}</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <button
                            type="button"
                            onClick={() => setDraft((d) => d && { ...d, targets: d.targets.filter((x) => x.key !== t.key) })}
                            title="Delete target"
                            className="w-6 h-6 flex items-center justify-center rounded text-klv-text-muted hover:text-red-600 hover:bg-red-50 transition-colors"
                          >
                            <TrashIcon />
                          </button>
                        </td>
                      </tr>
                      {open && live && (
                        <tr className="bg-klv-base/50">
                          <td />
                          <td colSpan={9} className="px-3 py-3">
                            <Streams streams={live.streams} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <datalist id="collector-namespaces">
              {namespaces?.map((n) => <option key={n} value={n} />)}
            </datalist>
          </div>
        )}
      </section>

      {/* Retention */}
      {draft && (
        <section className="klv-card px-5 py-4 animate-slide-up">
          <h3 className="font-display font-bold tracking-tight mb-3">Retention</h3>
          <div className="flex flex-wrap items-end gap-6">
            <label className="block">
              <span className="klv-section-label block mb-1">Max age (days)</span>
              <input
                type="number"
                min={AGE_BOUNDS.min}
                max={AGE_BOUNDS.max}
                value={draft.maxAgeDays}
                onChange={(e) => setDraft({ ...draft, maxAgeDays: e.target.value })}
                className="klv-input w-32 font-mono text-xs"
              />
            </label>
            <label className="block">
              <span className="klv-section-label block mb-1">Max size (MB)</span>
              <input
                type="number"
                min={SIZE_BOUNDS.min}
                max={SIZE_BOUNDS.max}
                value={draft.maxSizeMb}
                onChange={(e) => setDraft({ ...draft, maxSizeMb: e.target.value })}
                className="klv-input w-32 font-mono text-xs"
              />
            </label>
            <p className="text-xs text-klv-text-muted max-w-sm">
              Hourly segments older than the max age are deleted every minute; when the size limit is exceeded the oldest segments are removed first.
            </p>
          </div>
        </section>
      )}

      {/* Save bar */}
      {draft && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void save()} disabled={!dirty || !!validation || saving} className="klv-btn-primary">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => config && setDraft(toDraft(config))}
            disabled={!dirty || saving}
            className="klv-btn-secondary"
          >
            Discard
          </button>
          {dirty && validation && <span className="text-xs text-amber-600">{validation}</span>}
          {dirty && !validation && <span className="text-xs text-klv-text-muted">Unsaved changes — saving restarts the affected collectors</span>}
          {saveError && <span className="text-xs text-red-600 font-mono break-all">{saveError}</span>}
        </div>
      )}

      {/* Storage */}
      <section className="klv-card px-5 py-4 animate-slide-up">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display font-bold tracking-tight">Storage</h3>
          {!confirmClear && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={!status || status.stats.rows === 0}
              className="klv-btn text-xs !px-3 !py-1.5 border border-red-200 text-red-600 hover:bg-red-50"
            >
              Clear history
            </button>
          )}
        </div>

        {status ? (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="klv-section-label">Rows</dt>
              <dd className="font-mono text-klv-text tabular-nums">{status.stats.rows.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="klv-section-label">Size</dt>
              <dd className="font-mono text-klv-text tabular-nums">{formatBytes(status.stats.sizeBytes)}</dd>
            </div>
            <div>
              <dt className="klv-section-label">Oldest</dt>
              <dd className="font-mono text-klv-text-secondary text-xs">{status.stats.oldest ? formatTimestamp(status.stats.oldest) : '--'}</dd>
            </div>
            <div>
              <dt className="klv-section-label">Newest</dt>
              <dd className="font-mono text-klv-text-secondary text-xs">{status.stats.newest ? formatTimestamp(status.stats.newest) : '--'}</dd>
            </div>
            <div className="col-span-full">
              <dt className="klv-section-label">Data path</dt>
              <dd className="font-mono text-xs text-klv-text-muted break-all">{status.dataPath}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-klv-text-muted animate-pulse">Loading…</p>
        )}

        {confirmClear && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 flex flex-wrap items-center gap-3">
            <p className="text-sm text-red-600 flex-1 min-w-[240px]">
              Permanently delete all {status?.stats.rows.toLocaleString() ?? ''} stored log rows? This cannot be undone.
            </p>
            <button type="button" onClick={() => setConfirmClear(false)} disabled={clearing} className="klv-btn-secondary !px-3 !py-1.5 text-xs">
              Cancel
            </button>
            <button type="button" onClick={() => void clearHistory()} disabled={clearing} className="klv-btn-danger !px-3 !py-1.5 text-xs">
              {clearing ? 'Deleting…' : 'Delete everything'}
            </button>
            {clearError && <p className="w-full text-xs text-red-600 font-mono break-all">{clearError}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
