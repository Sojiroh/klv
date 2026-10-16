import { useEffect, useMemo, useRef, useState } from 'react';
import { parseQuery } from '../../lib/query';
import { useDismiss } from '../../hooks/useDismiss';
import { SearchIcon, XIcon } from './icons';

const APPLY_DEBOUNCE_MS = 300;

const SYNTAX_HELP: { example: string; meaning: string }[] = [
  { example: 'timeout', meaning: 'free text (case-insensitive)' },
  { example: '"connection refused"', meaning: 'exact phrase' },
  { example: 'time*out', meaning: 'wildcard' },
  { example: 'level:error', meaning: 'level (alias status); level:>=warn' },
  { example: 'service:api pod:web-*', meaning: 'fields: level, service, env, version, pod, container, namespace, trace, span, caller, message, error' },
  { example: '@http.status:>=500', meaning: 'attribute from the JSON body; >, >=, <, <=' },
  { example: '@duration:[100 TO 500]', meaning: 'numeric range (inclusive)' },
  { example: '@user.id:*', meaning: 'attribute exists' },
  { example: 'error OR panic', meaning: 'AND (implicit), OR, NOT — uppercase' },
  { example: '-healthcheck  -service:api', meaning: 'exclude a term or a field' },
  { example: '(a OR b) AND -c', meaning: 'parentheses group' },
];

interface Props {
  value: string;
  onApply: (query: string) => void;
  placeholder?: string;
}

export default function QueryBar({ value, onApply, placeholder = 'Search logs…  e.g. level:error service:api -healthcheck' }: Props) {
  const [draft, setDraft] = useState(value);
  const [helpOpen, setHelpOpen] = useState(false);
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

  const error = parsed.ok ? null : parsed;

  return (
    <div className="relative flex-1 min-w-[260px]">
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
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyNow(draft);
            else if (e.key === 'Escape') inputRef.current?.blur();
          }}
          className="flex-1 min-w-0 bg-transparent py-2 text-sm font-mono text-klv-text placeholder:text-klv-text-muted placeholder:font-body focus:outline-none"
        />
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
