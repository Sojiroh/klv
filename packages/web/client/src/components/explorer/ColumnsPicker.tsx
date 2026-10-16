import { useMemo, useRef, useState } from 'react';
import { BUILTIN_COLUMNS, DEFAULT_COLUMNS, columnLabel, type ColumnId } from '../../lib/columns';
import type { Facet } from '../../lib/facets';
import { useDismiss } from '../../hooks/useDismiss';
import { withColumn, withoutColumn } from './clauses';
import { ColumnsIcon, PlusIcon, XIcon } from './icons';

interface Props {
  columns: ColumnId[];
  /** Attribute facets of the current data offer ready-made `@attr` columns. */
  facets: Facet[];
  onChange: (columns: ColumnId[]) => void;
}

export default function ColumnsPicker({ columns, facets, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const attributeOptions = useMemo(
    () => facets.filter((f) => f.field.startsWith('@') && !columns.includes(f.field as ColumnId)).slice(0, 40),
    [facets, columns],
  );

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= columns.length) return;
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const addCustom = () => {
    const raw = custom.trim();
    if (!raw) return;
    const id = (raw.startsWith('@') ? raw : `@${raw}`) as ColumnId;
    if (/^@[^,\s]+$/.test(id)) onChange(withColumn(columns, id));
    setCustom('');
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`klv-btn text-xs !px-3 !py-1.5 inline-flex items-center gap-1.5 border transition-colors ${
          open
            ? 'bg-klv-accent/15 text-klv-accent border-klv-accent/30'
            : 'bg-klv-elevated text-klv-text-muted border-klv-border hover:text-klv-text-secondary'
        }`}
      >
        <ColumnsIcon />
        Columns
        <span className="font-mono text-[10px] text-klv-text-muted">{columns.length}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[300px] klv-card bg-klv-elevated shadow-xl shadow-slate-900/10 z-40 p-3 animate-fade-in max-h-[70vh] overflow-auto">
          <p className="klv-section-label mb-2">Shown (in order)</p>
          <ul className="space-y-0.5 mb-3">
            {columns.map((id, i) => (
              <li key={id} className="flex items-center gap-1 text-xs font-mono px-1.5 py-1 rounded hover:bg-klv-border/30 group">
                <span className="flex-1 truncate text-klv-text-secondary" title={id}>{columnLabel(id)}</span>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  className="px-1 text-klv-text-muted hover:text-klv-text disabled:opacity-20"
                  title="Move left"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === columns.length - 1}
                  onClick={() => move(i, 1)}
                  className="px-1 text-klv-text-muted hover:text-klv-text disabled:opacity-20"
                  title="Move right"
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={id === 'message'}
                  onClick={() => onChange(withoutColumn(columns, id))}
                  className="px-1 text-klv-text-muted hover:text-red-600 disabled:opacity-20"
                  title={id === 'message' ? 'The message column is always shown' : 'Remove column'}
                >
                  <XIcon className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>

          {BUILTIN_COLUMNS.some((id) => !columns.includes(id)) && (
            <>
              <p className="klv-section-label mb-1.5">Add field</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {BUILTIN_COLUMNS.filter((id) => !columns.includes(id)).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onChange(withColumn(columns, id))}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-md border border-klv-border text-klv-text-secondary hover:border-klv-accent/40 hover:text-klv-accent transition-colors"
                  >
                    <PlusIcon className="w-2.5 h-2.5" />
                    {columnLabel(id)}
                  </button>
                ))}
              </div>
            </>
          )}

          {attributeOptions.length > 0 && (
            <>
              <p className="klv-section-label mb-1.5">Add attribute</p>
              <div className="flex flex-wrap gap-1.5 mb-3 max-h-28 overflow-auto">
                {attributeOptions.map((f) => (
                  <button
                    key={f.field}
                    type="button"
                    onClick={() => onChange(withColumn(columns, f.field as ColumnId))}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-md border border-klv-border text-klv-text-secondary hover:border-klv-accent/40 hover:text-klv-accent transition-colors"
                  >
                    <PlusIcon className="w-2.5 h-2.5" />
                    {f.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="flex gap-1.5">
            <input
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCustom()}
              placeholder="@attr.path"
              className="klv-input flex-1 !py-1 text-xs font-mono"
            />
            <button type="button" onClick={addCustom} className="klv-btn-secondary !px-2.5 !py-1 text-xs">
              Add
            </button>
          </div>

          <button
            type="button"
            onClick={() => onChange([...DEFAULT_COLUMNS])}
            className="mt-3 text-[11px] text-klv-text-muted hover:text-klv-accent transition-colors"
          >
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}
