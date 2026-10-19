import { createElement, type ReactNode } from 'react';
import type { QueryNode } from './query';

const MAX_MARKS = 100;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardSource(value: string): string {
  let out = '';
  for (const char of value) {
    out += char === '*' ? '[^\\n]*?' : char === '?' ? '.' : escapeRegExp(char);
  }
  return out;
}

function collect(node: QueryNode, out: { value: string; wildcard: boolean }[]): void {
  switch (node.type) {
    case 'and':
    case 'or':
      node.children.forEach((child) => collect(child, out));
      return;
    case 'text':
      out.push({ value: node.value, wildcard: node.wildcard });
      return;
    default:
      return;
  }
}

/** Case-insensitive pattern matching every free-text term outside a `NOT`; null when there are none. */
export function highlightPattern(ast: QueryNode | null): RegExp | null {
  if (!ast) return null;
  const terms: { value: string; wildcard: boolean }[] = [];
  collect(ast, terms);
  const sources = terms
    .filter((t) => t.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length)
    .map((t) => (t.wildcard ? wildcardSource(t.value) : escapeRegExp(t.value)));
  if (sources.length === 0) return null;
  try {
    return new RegExp(sources.join('|'), 'giu');
  } catch {
    return null;
  }
}

/** Wraps every match of `pattern` in `<mark>`; returns `text` unchanged when nothing matches. */
export function highlight(text: string, pattern: RegExp | null): ReactNode {
  if (!pattern || !text) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  let marks = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      createElement('mark', { key: start, className: 'bg-amber-100 text-inherit rounded-sm' }, match[0]),
    );
    last = start + match[0].length;
    if (++marks >= MAX_MARKS) break;
  }
  if (marks === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
