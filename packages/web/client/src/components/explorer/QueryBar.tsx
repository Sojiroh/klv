import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseQuery, quoteQueryValue } from '../../lib/query';
import type { Facet } from '../../lib/facets';
import { useDismiss } from '../../hooks/useDismiss';
import { SearchIcon, XIcon } from './icons';

const APPLY_DEBOUNCE_MS = 300;

const SYNTAX_HELP: { example: string; meaning: string }[] = [
  { example: 'timeout', meaning: 'free text: searches message, error and stack only (case-insensitive)' },
  { example: '"connection refused"', meaning: 'exact phrase' },
  { example: 'time*out  te?t', meaning: 'wildcards: * any text, ? one character (escape with \\)' },
  { example: 'level:error', meaning: 'level (alias status); level:>=warn' },
  { example: 'service:api pod:web-*', meaning: 'fields: level, service, env, version, pod, container, namespace, trace, span, caller, message, error' },
  { example: 'service:(web OR api)', meaning: 'several values for one field (OR, AND, NOT inside the parentheses)' },
  { example: '@http.status:>=500', meaning: 'attribute from the JSON body; >, >=, <, <=' },
  { example: '@duration:[100 TO 500]', meaning: 'numeric range (inclusive)' },
  { example: '@user.id:*', meaning: 'attribute exists' },
  { example: 'error OR panic', meaning: 'AND (implicit), OR, NOT — uppercase' },
  { example: '-healthcheck  -service:api', meaning: 'exclude a term or a field' },
  { example: '(a OR b) AND -c', meaning: 'parentheses group' },
];

const MAX_SUGGESTIONS = 8;
const FIELD_NAMES = ['level', 'service', 'env', 'version', 'pod', 'container', 'namespace', 'trace', 'span', 'caller', 'message', 'error'];
const LEVEL_VALUES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const FIELD_ALIASES: Record<string, string> = {
  status: 'level',
  ns: 'namespace',
  trace_id: 'trace',
  traceid: 'trace',
  span_id: 'span',
  spanid: 'span',
  msg: 'message',
  'dd.trace_id': 'trace',
  'dd.span_id': 'span',
  'dd.service': 'service',
  'dd.env': 'env',
  'dd.version': 'version',
};

interface Suggestion {
  kind: 'field' | 'value';
  label: string;
  /** Text inserted in place of the current token (field: `name:`; value: quoted value plus a space). */
  insert: string;
  count?: number;
}

interface Completion {
  items: Suggestion[];
  /** Replacement range in the draft. */
  from: number;
  to: number;
}

/** Case-insensitive prefix matches first, then contains matches. */
function rank<T>(items: T[], text: (item: T) => string, needle: string): T[] {
  const n = needle.toLowerCase();
  if (!n) return items;
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const t = text(item).toLowerCase();
    if (t.startsWith(n)) prefix.push(item);
    else if (t.includes(n)) contains.push(item);
  }
  return [...prefix, ...contains];
}

function isUnclosedQuote(text: string): boolean {
  let open = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') open = !open;
  }
  return open;
}

function complete(draft: string, caret: number, facets: Facet[]): Completion | null {
  if (isUnclosedQuote(draft.slice(0, caret))) return null;
  const isBound = (c: string) => /\s/.test(c) || c === '(' || c === ')';
  let start = caret;
  while (start > 0 && !isBound(draft[start - 1])) start--;
  let end = caret;
  while (end < draft.length && !isBound(draft[end])) end++;
  if (draft[start] === '-') start++;
  const text = draft.slice(start, caret);
  if (!text || text.startsWith('"')) return null;

  const colon = text.indexOf(':');
  if (colon < 0) {
    const items: Suggestion[] = [];
    if (text.startsWith('@')) {
      for (const f of rank(facets.filter((x) => x.field.startsWith('@')), (x) => x.field, text)) {
        items.push({ kind: 'field', label: f.field, insert: `${f.field}:`, count: f.total });
      }
    } else {
      const names = rank(FIELD_NAMES, (x) => x, text);
      for (const name of names) {
        const facet = facets.find((f) => f.field === name);
        items.push({ kind: 'field', label: name, insert: `${name}:`, count: facet?.total });
      }
    }
    return items.length ? { items: items.slice(0, MAX_SUGGESTIONS), from: start, to: end } : null;
  }

  const name = text.slice(0, colon);
  const valueText = text.slice(colon + 1);
  if (/^[([><"]/.test(valueText)) return null;
  const key = name.replace(/^@(?=dd\.)/, '');
  const field = FIELD_ALIASES[key] ?? name;
  const facet = facets.find((f) => f.field === field);
  let values = facet ? facet.values.map((v) => ({ value: v.value, count: v.count as number | undefined })) : [];
  if (!facet && field === 'level') values = LEVEL_VALUES.map((value) => ({ value, count: undefined }));
  const items = rank(values, (v) => v.value, valueText)
    .slice(0, MAX_SUGGESTIONS)
    .map<Suggestion>((v) => ({ kind: 'value', label: v.value, insert: `${quoteQueryValue(v.value)} `, count: v.count }));
  return items.length ? { items, from: start + colon + 1, to: end } : null;
}

interface Props {
  value: string;
  onApply: (query: string) => void;
  placeholder?: string;
  facets?: Facet[];
}

export default function QueryBar({ value, onApply, placeholder = 'Search logs…  e.g. level:error service:api -healthcheck', facets }: Props) {
  const [draft, setDraft] = useState(value);
  const [helpOpen, setHelpOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const lastFacets = useRef<Facet[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const applied = useRef(value);

  useEffect(() => {
    if (value !== applied.current) {
      applied.current = value;
      setDraft(value);
    }
  }, [value]);

  const parsed = useMemo(() => parseQuery(draft), [draft]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [draft]);

  // Una consulta sin resultados vacía los facets: se reutilizan los últimos no vacíos para seguir sugiriendo.
  if (facets && facets.length > 0) lastFacets.current = facets;
  const suggestFacets = facets && facets.length > 0 ? facets : lastFacets.current;
  const completion = useMemo(() => (suggestOpen ? complete(draft, caret, suggestFacets) : null), [suggestOpen, draft, caret, suggestFacets]);
  const popupVisible = completion !== null;

  useEffect(() => setActiveIndex(-1), [draft, caret]);

  useDismiss(rootRef, popupVisible, () => setSuggestOpen(false));

  useEffect(() => {
    if (!parsed.ok || draft === applied.current) return;
    const timer = setTimeout(() => {
      applied.current = draft;
      onApply(draft);
    }, APPLY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, parsed.ok, onApply]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useDismiss(helpRef, helpOpen, () => setHelpOpen(false));

  const applyNow = (text: string) => {
    if (!parseQuery(text).ok) return;
    applied.current = text;
    onApply(text);
  };

  const accept = (item: Suggestion) => {
    if (!completion) return;
    const next = draft.slice(0, completion.from) + item.insert + draft.slice(completion.to);
    const pos = completion.from + item.insert.length;
    pendingCaret.current = pos;
    setDraft(next);
    setCaret(pos);
    setSuggestOpen(item.kind === 'field');
    inputRef.current?.focus();
  };

  const error = parsed.ok || popupVisible ? null : parsed;

  return (
    <div ref={rootRef} className="relative flex-1 min-w-[260px]">
      <div
        className={`flex items-center gap-2 bg-klv-elevated border rounded-lg px-3 transition-all duration-200
                    focus-within:ring-1 ${error
                      ? 'border-red-400 focus-within:ring-red-500/15'
                      : 'border-klv-border focus-within:border-klv-accent/50 focus-within:ring-klv-accent/20'}`}
      >
        <SearchIcon className="w-3.5 h-3.5 text-klv-text-muted shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setSuggestOpen(true);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={() => setSuggestOpen(true)}
          onKeyDown={(e) => {
            const items = completion?.items ?? [];
            if (popupVisible && e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, items.length - 1));
            } else if (popupVisible && e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (popupVisible && e.key === 'Tab') {
              e.preventDefault();
              accept(items[Math.max(activeIndex, 0)]);
            } else if (e.key === 'Enter') {
              if (popupVisible && activeIndex >= 0) {
                e.preventDefault();
                accept(items[activeIndex]);
              } else {
                applyNow(draft);
              }
            } else if (e.key === 'Escape') {
              if (popupVisible) setSuggestOpen(false);
              else inputRef.current?.blur();
            }
          }}
          className="flex-1 min-w-0 bg-transparent py-2 text-sm font-mono text-klv-text placeholder:text-klv-text-muted placeholder:font-body focus:outline-none"
        />
        {completion && (
          <div
            role="listbox"
            className="absolute left-0 top-full mt-1 w-full max-w-[560px] klv-card bg-klv-surface border border-klv-border shadow-xl shadow-slate-900/10 z-40 py-1 animate-fade-in"
          >
            {completion.items.map((item, i) => (
              <div
                key={`${item.kind}:${item.label}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(item)}
                className={`flex items-center justify-between gap-3 px-3 py-1 text-xs font-mono cursor-pointer ${
                  i === activeIndex ? 'bg-klv-accent/10 text-klv-accent' : 'text-klv-text hover:bg-klv-elevated'
                }`}
              >
                <span className="truncate">{item.label}</span>
                {item.count !== undefined && <span className="text-klv-text-muted shrink-0">{item.count}</span>}
              </div>
            ))}
          </div>
        )}
        {draft && (
          <button
            type="button"
            onClick={() => {
              setDraft('');
              applyNow('');
              inputRef.current?.focus();
            }}
            className="text-klv-text-muted hover:text-klv-text transition-colors"
            title="Clear query"
          >
            <XIcon />
          </button>
        )}
        <kbd className="hidden sm:inline text-[10px] font-mono text-klv-text-muted border border-klv-border rounded px-1.5 py-px">/</kbd>
        <div ref={helpRef} className="relative">
          <button
            type="button"
            onClick={() => setHelpOpen((open) => !open)}
            className={`w-5 h-5 rounded-full text-[11px] font-mono border transition-colors ${
              helpOpen
                ? 'border-klv-accent/50 text-klv-accent'
                : 'border-klv-border text-klv-text-muted hover:text-klv-text-secondary'
            }`}
            title="Query syntax"
          >
            ?
          </button>
          {helpOpen && (
            <div className="absolute right-0 top-full mt-2 w-[440px] max-w-[90vw] klv-card bg-klv-surface border border-klv-border shadow-xl shadow-slate-900/10 z-40 p-4 animate-fade-in">
              <p className="klv-section-label mb-2">Query syntax</p>
              <ul className="space-y-1.5">
                {SYNTAX_HELP.map((row) => (
                  <li key={row.example} className="grid grid-cols-[170px_1fr] gap-3 text-xs">
                    <code className="font-mono text-klv-accent break-all">{row.example}</code>
                    <span className="text-klv-text-muted">{row.meaning}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-klv-text-muted mt-3">
                Click a facet value to add it; Alt-click (or −) excludes it.
              </p>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-1.5 text-xs font-mono text-red-600 animate-fade-in">
          <div className="whitespace-pre overflow-x-auto text-klv-text-muted">
            {draft.slice(0, error.position)}
            <span className="text-red-600 underline decoration-wavy decoration-red-500/70 underline-offset-4">
              {draft.charAt(error.position) || '\u00a0'}
            </span>
            {draft.slice(error.position + 1)}
          </div>
          <span>
            Syntax error at position {error.position + 1}: {error.error}
          </span>
        </div>
      )}
    </div>
  );
}
