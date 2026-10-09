import { useMemo, useState } from 'react';
import type { Facet } from '../../lib/facets';
import { fieldClause } from '../../lib/query';
import { levelConfig } from '../../utils/log-utils';
import { clauseState } from './clauses';
import { ChevronDownIcon, ChevronRightIcon, MinusIcon } from './icons';

interface Props {
  facets: Facet[];
  query: string;
  maxHeight: string;
  onToggle: (clause: string, mode: 'include' | 'exclude') => void;
}

export default function FacetsPanel({ facets, query, maxHeight, onToggle }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? facets.filter((f) => f.label.toLowerCase().includes(needle) || f.field.toLowerCase().includes(needle)) : facets;
  }, [facets, filter]);

  const isCollapsed = (facet: Facet) => collapsed[facet.field] ?? facet.field.startsWith('@');

  return (
    <div className="klv-card flex flex-col overflow-hidden" style={{ maxHeight }}>
      <div className="px-3 py-2.5 border-b border-klv-border shrink-0">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter facets…"
          className="klv-input w-full !py-1 text-xs"
        />
      </div>

      <div className="overflow-auto flex-1">
        {visible.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-klv-text-muted">No facets</p>
        )}
        {visible.map((facet) => (
          <section key={facet.field} className="border-b border-klv-border-subtle last:border-0">
            <button
              type="button"
              onClick={() => setCollapsed((prev) => ({ ...prev, [facet.field]: !isCollapsed(facet) }))}
              className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-klv-elevated/40 transition-colors"
            >
              {isCollapsed(facet)
                ? <ChevronRightIcon className="w-3 h-3 text-klv-text-muted" />
                : <ChevronDownIcon className="w-3 h-3 text-klv-text-muted" />}
              <span
                className={`klv-section-label !text-klv-text-secondary truncate flex-1 ${
                  facet.field.startsWith('@') ? '!normal-case !tracking-normal font-mono' : ''
                }`}
                title={facet.field}
              >
                {facet.label}
              </span>
              <span className="text-[10px] font-mono text-klv-text-muted tabular-nums">{facet.total}</span>
            </button>

            {!isCollapsed(facet) && (
              <ul className="pb-1.5">
                {facet.values.map((item) => {
                  const clause = fieldClause(facet.field, item.value);
                  const state = clauseState(query, clause);
                  const pct = facet.total > 0 ? (item.count / facet.total) * 100 : 0;
                  const levelColor = facet.field === 'level' ? levelConfig[item.value]?.color : undefined;
                  return (
                    <li key={item.value} className="group relative">
                      <button
                        type="button"
                        onClick={(e) => onToggle(clause, e.altKey ? 'exclude' : 'include')}
                        title={`${item.value} — click to filter, Alt-click to exclude`}
                        className={`relative w-full flex items-center gap-2 pl-4 pr-8 py-[3px] text-left text-xs font-mono overflow-hidden
                                    hover:bg-klv-elevated/50 transition-colors ${
                                      state === 'include' ? 'bg-klv-accent/10' : ''
                                    }`}
                      >
                        <span
                          className={`absolute inset-y-0 left-0 ${state === 'exclude' ? 'bg-red-500/10' : 'bg-klv-accent/10'}`}
                          style={{ width: `${pct}%` }}
                        />
                        <span
                          className={`relative truncate flex-1 ${
                            state === 'include'
                              ? 'text-klv-accent'
                              : state === 'exclude'
                                ? 'text-red-400 line-through'
                                : (levelColor ?? 'text-klv-text-secondary')
                          }`}
                        >
                          {item.value || '(empty)'}
                        </span>
                        <span className="relative text-klv-text-muted tabular-nums group-hover:opacity-0 transition-opacity">
                          {item.count}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggle(clause, 'exclude')}
                        title="Exclude"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded
                                   text-klv-text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-all"
                      >
                        <MinusIcon className="w-3 h-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
