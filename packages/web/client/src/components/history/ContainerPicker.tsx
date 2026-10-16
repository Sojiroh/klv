import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDismiss } from '../../hooks/useDismiss';
import { apiRequest, errorMessage } from '../../lib/api';

interface Props {
  context: string;
  namespace: string;
  labelSelector: string;
  /** Selected container names; empty = all containers. */
  selected: string[];
  onChange: (containers: string[]) => void;
}

const POPOVER_WIDTH = 260;
const POPOVER_GAP = 4;

function summary(selected: string[]): string {
  if (selected.length === 0) return 'All containers';
  if (selected.length <= 2) return selected.join(', ');
  return `${selected.length} containers`;
}

export default function ContainerPicker({ context, namespace, labelSelector, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const ns = namespace.trim();
  const ctx = context.trim();
  const label = labelSelector.trim();
  const disabled = !ns || !ctx;

  // La tabla vive en un contenedor con scroll: el popover usa posición fija anclada al botón.
  const reposition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
    setPosition({ left, top: rect.bottom + POPOVER_GAP });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || disabled) return;
    const controller = new AbortController();
    setNames(null);
    setError(null);
    const params = new URLSearchParams({ context: ctx });
    if (label) params.set('label', label);
    apiRequest<string[]>(`/api/containers/${encodeURIComponent(ns)}?${params}`, { signal: controller.signal }).then(
      (list) => {
        if (!controller.signal.aborted) setNames(list);
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      },
    );
    return () => controller.abort();
  }, [open, disabled, ns, ctx, label]);

  const missing = useMemo(
    () => (names ? selected.filter((c) => !names.includes(c)) : error ? selected : []),
    [names, error, selected],
  );

  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((c) => c !== name) : [...selected, name]);

  const loading = names === null && error === null;
  const rowClass = 'flex items-center gap-2 px-3 py-1.5 text-xs font-mono cursor-pointer hover:bg-klv-surface';

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        title={disabled ? 'Choose a namespace first' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="klv-input w-full !py-1 text-xs font-mono text-left flex items-center justify-between gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className={`truncate ${selected.length === 0 ? 'text-klv-text-muted' : ''}`}>{summary(selected)}</span>
        <span aria-hidden className="text-klv-text-muted shrink-0">▾</span>
      </button>

      {open && position && (
        <div
          style={{ left: position.left, top: position.top, width: POPOVER_WIDTH }}
          className="fixed bg-klv-surface border border-klv-border shadow-xl shadow-slate-900/10 rounded-lg z-40 animate-fade-in"
        >
          <div className="max-h-[260px] overflow-auto py-1">
            <label className={rowClass}>
              <input
                type="checkbox"
                checked={selected.length === 0}
                onChange={() => onChange([])}
                className="accent-klv-accent"
              />
              <span>All containers</span>
            </label>

            {loading && <p className="px-3 py-2 text-xs text-klv-text-muted animate-pulse">Loading containers…</p>}
            {error && <p className="px-3 py-2 text-xs text-red-600 break-words">{error}</p>}
            {names && names.length === 0 && (
              <p className="px-3 py-2 text-xs text-klv-text-muted break-all">No containers found in {ns}</p>
            )}

            {names?.map((name) => (
              <label key={name} className={rowClass}>
                <input
                  type="checkbox"
                  checked={selected.includes(name)}
                  onChange={() => toggle(name)}
                  className="accent-klv-accent"
                />
                <span className="truncate">{name}</span>
              </label>
            ))}

            {missing.map((name) => (
              <label key={name} className={`${rowClass} text-klv-text-muted`}>
                <input type="checkbox" checked onChange={() => toggle(name)} className="accent-klv-accent" />
                <span className="truncate">{name}</span>
                {names && (
                  <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-klv-border">
                    not found
                  </span>
                )}
              </label>
            ))}
          </div>
          <div className="flex justify-end border-t border-klv-border px-3 py-2">
            <button type="button" onClick={close} className="klv-btn-secondary !px-3 !py-1 text-xs">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
