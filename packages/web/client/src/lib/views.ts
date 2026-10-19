/** Vista guardada del explorador: consulta + rango + columnas + vista + agrupación del histograma. */
export interface SavedView {
  id: string;
  name: string;
  q: string;
  range: string | null;
  from: string | null;
  to: string | null;
  cols: string | null;
  view: string | null;
  by: string | null;
  createdAt: number;
}

export const VIEWS_KEY = 'klv.explorer.views';
export const RECENT_KEY = 'klv.explorer.recent';
export const MAX_RECENT = 10;
export const MAX_VIEWS = 50;

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Captures the shareable explorer URL state under `name`. */
export function snapshotView(name: string, params: URLSearchParams): SavedView {
  return {
    id: newId(),
    name: name.trim(),
    q: params.get('q') ?? '',
    range: params.get('range'),
    from: params.get('from'),
    to: params.get('to'),
    cols: params.get('cols'),
    view: params.get('view'),
    by: params.get('by'),
    createdAt: Date.now(),
  };
}

/** Patch for `ExplorerParams.update` that restores a saved view (clears any selected pattern). */
export function viewPatch(view: SavedView): Record<string, string | null> {
  return {
    q: view.q,
    range: view.range,
    from: view.from,
    to: view.to,
    cols: view.cols,
    view: view.view,
    by: view.by,
    pattern: null,
  };
}

/** Puts `query` first (trimmed, deduplicated), ignoring empty queries, capped at MAX_RECENT. */
export function pushRecent(recent: string[], query: string): string[] {
  const q = query.trim();
  if (!q) return recent;
  return [q, ...recent.filter((r) => r !== q)].slice(0, MAX_RECENT);
}
