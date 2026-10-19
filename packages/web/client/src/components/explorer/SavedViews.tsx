import { useEffect, useRef, useState } from 'react';
import type { ExplorerParams } from '../../hooks/useExplorerParams';
import { useDismiss } from '../../hooks/useDismiss';
import { usePersistentState } from '../../hooks/usePersistentState';
import { MAX_VIEWS, RECENT_KEY, VIEWS_KEY, pushRecent, snapshotView, viewPatch, type SavedView } from '../../lib/views';
import { BookmarkIcon, XIcon } from './icons';
import ToolbarToggle from './ToolbarToggle';

interface Props {
  params: ExplorerParams;
}

export default function SavedViews({ params }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [views, setViews] = usePersistentState<SavedView[]>(VIEWS_KEY, []);
  const [recent, setRecent] = usePersistentState<string[]>(RECENT_KEY, []);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const recentRef = useRef(recent);
  recentRef.current = recent;
  useEffect(() => {
    const q = params.query.trim();
    if (!q || recentRef.current[0] === q) return;
    setRecent(pushRecent(recentRef.current, q));
  }, [params.query, setRecent]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const snapshot = snapshotView(trimmed, params.searchParams);
    const key = trimmed.toLowerCase();
    const others = views.filter((v) => v.name.toLowerCase() !== key);
    setViews([snapshot, ...others].slice(0, MAX_VIEWS));
    setName('');
  };

  const apply = (view: SavedView) => {
    params.update(viewPatch(view));
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <ToolbarToggle active={open} onClick={() => setOpen((v) => !v)} title="Saved views and recent queries">
        <BookmarkIcon />
        Views
      </ToolbarToggle>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[360px] klv-card bg-klv-surface border border-klv-border shadow-xl shadow-slate-900/10 z-40 p-3 animate-fade-in max-h-[70vh] overflow-auto">
          <p className="klv-section-label mb-1.5">Save current view</p>
          <div className="flex gap-1.5 mb-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder="View name"
              className="klv-input flex-1 !py-1 text-xs"
            />
            <button
              type="button"
              onClick={save}
              disabled={!name.trim()}
              className="klv-btn-secondary !px-2.5 !py-1 text-xs disabled:opacity-40"
            >
              Save
            </button>
          </div>

          <p className="klv-section-label mb-1.5">Saved views</p>
          {views.length === 0 ? (
            <p className="text-xs text-klv-text-muted mb-3">No saved views yet.</p>
          ) : (
            <ul className="space-y-0.5 mb-3">
              {views.map((v) => (
                <li key={v.id} className="group flex items-center gap-1 rounded hover:bg-klv-border/30">
                  <button type="button" onClick={() => apply(v)} className="flex-1 min-w-0 text-left px-1.5 py-1">
                    <span className="block text-xs font-medium text-klv-text truncate">{v.name}</span>
                    <span className="block text-[11px] font-mono text-klv-text-muted truncate" title={v.q}>
                      {v.q || '(no query)'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setViews(views.filter((x) => x.id !== v.id))}
                    className="px-1.5 text-klv-text-muted hover:text-red-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                    title="Delete view"
                  >
                    <XIcon className="w-3 h-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between mb-1.5">
            <p className="klv-section-label">Recent queries</p>
            {recent.length > 0 && (
              <button
                type="button"
                onClick={() => setRecent([])}
                className="text-[11px] text-klv-text-muted hover:text-klv-accent transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          {recent.length === 0 ? (
            <p className="text-xs text-klv-text-muted">No recent queries.</p>
          ) : (
            <ul className="space-y-0.5">
              {recent.map((q) => (
                <li key={q}>
                  <button
                    type="button"
                    onClick={() => {
                      params.setQuery(q);
                      setOpen(false);
                    }}
                    className="w-full text-left px-1.5 py-1 rounded text-[11px] font-mono text-klv-text-secondary truncate hover:bg-klv-border/30"
                    title={q}
                  >
                    {q}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
