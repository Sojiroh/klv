import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { isColumnId, type ColumnId } from '../lib/columns';
import { rawFieldFilter } from '../lib/query';
import type { ParsedLog } from '../types';
import { prettyRaw } from '../utils/log-utils';

interface Props {
  log: ParsedLog;
  columns: ColumnId[];
  onFilter: (clause: string, mode: 'include' | 'exclude') => void;
  onToggleColumn: (id: ColumnId) => void;
}

/** A clicked key or value of the raw JSON. */
interface Choice {
  /** Render-order index of the clicked token (highlights it while the menu is open). */
  token: number;
  kind: 'key' | 'value';
  /** Dotted path from the root; array elements use the array's path; null inside arrays of objects. */
  path: string | null;
  value: unknown;
  /** Key name or the value as text. */
  label: string;
}

interface Anchor {
  x: number;
  y: number;
  /** Open upwards when there is no room below the token. */
  above: boolean;
}

const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 240;

/** The JSON object of the line, with or without the kubelet timestamp prefix. */
function parseRecord(raw: string): Record<string, unknown> | null {
  for (const text of [raw, raw.match(/^\S+\s+(\{.*)$/s)?.[1]]) {
    if (text === undefined) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Se prueba la siguiente forma
    }
  }
  return null;
}

function scalarClass(value: unknown): string {
  if (typeof value === 'string') return 'text-klv-text';
  if (typeof value === 'number') return 'text-sky-700';
  return 'text-amber-700';
}

interface MenuProps extends Props {
  choice: Choice;
  anchor: Anchor;
  onClose: () => void;
}

function FieldMenu({ log, choice, anchor, columns, onFilter, onToggleColumn, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const filter = useMemo(
    () => (choice.path === null ? null : rawFieldFilter(log, choice.path, choice.value)),
    [log, choice],
  );

  useEffect(() => {
    // Capture + stopPropagation: Escape closes only this menu, not the details panel it sits on
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const run = (action: () => void) => {
    action();
    onClose();
  };
  const copy = (text: string) => run(() => void navigator.clipboard.writeText(text).catch(() => undefined));

  // Value menus filter by `field:value`; key menus (and values that cannot be matched) by `field:*`
  const clause = choice.kind === 'value' && filter?.equals ? filter.equals : filter?.exists ?? null;
  const exists = clause !== null && clause === filter?.exists;
  const column = filter && isColumnId(filter.field) ? filter.field : null;
  const copyText = choice.kind === 'key'
    ? filter?.field ?? choice.path ?? choice.label
    : typeof choice.value === 'string' ? choice.value : JSON.stringify(choice.value);

  const item = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-klv-elevated transition-colors';

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[90] bg-klv-surface border border-klv-border rounded-lg shadow-xl shadow-slate-900/10 py-1 animate-fade-in"
      style={{
        left: anchor.x,
        top: anchor.y,
        width: MENU_WIDTH,
        maxHeight: MENU_MAX_HEIGHT,
        transform: anchor.above ? 'translateY(-100%)' : undefined,
      }}
    >
      <p className="px-3 pt-1 pb-1.5 font-mono text-[11px] text-klv-text-muted truncate border-b border-klv-border-subtle" title={filter?.field ?? choice.path ?? choice.label}>
        {filter?.field ?? choice.path ?? choice.label}
        {choice.kind === 'value' && <span className="text-klv-text-secondary"> = {choice.label}</span>}
      </p>

      {clause ? (
        <>
          {choice.kind === 'value' && exists && (
            <p className="px-3 pt-1.5 text-[11px] text-klv-text-muted">
              This value is not searchable (another key supplies the parsed field, or it is empty).
            </p>
          )}
          <button type="button" role="menuitem" className={item} onClick={() => run(() => onFilter(clause, 'include'))}>
            <span className="text-klv-text-secondary shrink-0">{exists ? 'Has field' : 'Filter by'}</span>
            <code className="font-mono text-klv-accent truncate">{clause}</code>
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => run(() => onFilter(clause, 'exclude'))}>
            <span className="text-klv-text-secondary shrink-0">{exists ? 'Missing field' : 'Exclude'}</span>
            <code className="font-mono text-red-600 truncate">-{clause}</code>
          </button>
        </>
      ) : (
        <p className="px-3 py-1.5 text-[11px] text-klv-text-muted">
          Not searchable with the query language (no field reads this key, or its name cannot be written in a query).
        </p>
      )}

      <div className="border-t border-klv-border-subtle mt-1 pt-1">
        {column && (
          <button type="button" role="menuitem" className={item} onClick={() => run(() => onToggleColumn(column))}>
            <span className="text-klv-text-secondary">{columns.includes(column) ? 'Remove column' : 'Add as column'}</span>
            <code className="font-mono text-klv-text-muted truncate">{column}</code>
          </button>
        )}
        <button type="button" role="menuitem" className={item} onClick={() => copy(copyText)}>
          <span className="text-klv-text-secondary">{choice.kind === 'key' ? 'Copy field name' : 'Copy value'}</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Pretty-printed raw JSON whose keys and values open a filter menu (Datadog-style). */
export default function RawJsonView({ log, columns, onFilter, onToggleColumn }: Props) {
  const record = useMemo(() => (log.isJson ? parseRecord(log.raw) : null), [log]);
  const [open, setOpen] = useState<{ choice: Choice; anchor: Anchor } | null>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => setOpen(null), [log]);

  const pre = 'text-xs text-klv-text-secondary font-mono bg-klv-base rounded-lg border border-klv-border p-4 overflow-auto whitespace-pre-wrap break-all';
  if (record === null) return <pre className={pre}>{log.isJson ? prettyRaw(log.raw) : log.raw}</pre>;

  const choose = (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, choice: Choice) => {
    // Dragging to select text inside a token must not open the menu
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(e.currentTarget, true)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const above = rect.bottom + MENU_MAX_HEIGHT + 8 > window.innerHeight && rect.top > MENU_MAX_HEIGHT;
    setOpen({
      choice,
      anchor: {
        x: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
        y: above ? rect.top - 4 : rect.bottom + 4,
        above,
      },
    });
  };

  let counter = 0;
  const token = (text: string, className: string, target: Omit<Choice, 'token'>): ReactNode => {
    const choice: Choice = { ...target, token: counter++ };
    const active = open?.choice.token === choice.token;
    return (
      <span
        key={`t${choice.token}`}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        title={choice.kind === 'key' ? 'Filter by this field' : 'Filter by this value'}
        className={`${className} cursor-pointer rounded-sm hover:bg-klv-accent/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-klv-accent ${
          active ? 'bg-klv-accent/15' : ''
        }`}
        onClick={(e) => choose(e, choice)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          choose(e, choice);
        }}
      >
        {text}
      </span>
    );
  };

  // Same layout as JSON.stringify(value, null, 2)
  const render = (value: unknown, path: string | null, indent: string): ReactNode => {
    const inner = `${indent}  `;
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      return (
        <>
          {'[\n'}
          {value.map((item, i) => (
            <Fragment key={i}>
              {inner}
              {/* Query paths do not index into arrays: scalars keep the array's path, objects become unaddressable */}
              {render(item, item !== null && typeof item === 'object' ? null : path, inner)}
              {i < value.length - 1 ? ',\n' : '\n'}
            </Fragment>
          ))}
          {indent}]
        </>
      );
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) return '{}';
      return (
        <>
          {'{\n'}
          {entries.map(([key, child], i) => {
            const childPath = path === null ? null : path === '' ? key : `${path}.${key}`;
            return (
              <Fragment key={key}>
                {inner}
                {token(JSON.stringify(key), 'text-violet-700', { kind: 'key', path: childPath, value: child, label: key })}
                {': '}
                {render(child, childPath, inner)}
                {i < entries.length - 1 ? ',\n' : '\n'}
              </Fragment>
            );
          })}
          {indent}
          {'}'}
        </>
      );
    }
    const text = JSON.stringify(value);
    return token(text, scalarClass(value), { kind: 'value', path, value, label: typeof value === 'string' ? value : text });
  };

  return (
    <>
      <pre className={pre}>{render(record, '', '')}</pre>
      {open && (
        <FieldMenu
          log={log}
          choice={open.choice}
          anchor={open.anchor}
          columns={columns}
          onFilter={onFilter}
          onToggleColumn={onToggleColumn}
          onClose={close}
        />
      )}
    </>
  );
}
