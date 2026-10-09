import type { QueryableLog } from '@klv/query';
import type { LogLevel } from '../types';
import { logTime } from './time';

export interface LogPattern {
  id: string;
  signature: string;
  count: number;
  levels: Partial<Record<LogLevel, number>>;
  sample: QueryableLog;
  firstSeen: number | null;
  lastSeen: number | null;
}

const MAX_SIGNATURE_LENGTH = 300;

// Order matters: quoted strings swallow whatever they contain, then the most specific tokens go first.
const SUBSTITUTIONS: [RegExp, string][] = [
  [/"(?:[^"\\]|\\.)*"/g, '"<str>"'],
  [/(?<!\w)'(?:[^'\\]|\\.)*'(?!\w)/g, '"<str>"'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '<ip>'],
  // Needs a digit and a letter so plain words ("defaced") and plain numbers are left to other rules.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>'],
  // Numbers not glued to a preceding identifier: "9ms" → "<num>ms", while "v2" or "user42" stay.
  [/(?<![A-Za-z_\d.])\d+(?:\.\d+)?/g, '<num>'],
];

export function messageSignature(message: string): string {
  let text = message;
  for (const [pattern, replacement] of SUBSTITUTIONS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > MAX_SIGNATURE_LENGTH ? text.slice(0, MAX_SIGNATURE_LENGTH) : text;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function logSignature(log: QueryableLog): string {
  return messageSignature(log.message || log.raw);
}

export function patternId(log: QueryableLog): string {
  return fnv1a(logSignature(log));
}

/** Groups logs by message signature, most frequent first. Single pass. */
export function computePatterns(logs: QueryableLog[]): LogPattern[] {
  const byId = new Map<string, LogPattern>();

  for (const log of logs) {
    const signature = logSignature(log);
    const id = fnv1a(signature);
    const time = logTime(log);

    let pattern = byId.get(id);
    if (!pattern) {
      pattern = { id, signature, count: 0, levels: {}, sample: log, firstSeen: null, lastSeen: null };
      byId.set(id, pattern);
    }
    pattern.count++;
    pattern.levels[log.level] = (pattern.levels[log.level] ?? 0) + 1;
    if (time !== null) {
      if (pattern.firstSeen === null || time < pattern.firstSeen) pattern.firstSeen = time;
      if (pattern.lastSeen === null || time > pattern.lastSeen) pattern.lastSeen = time;
    }
  }

  return [...byId.values()].sort((a, b) => b.count - a.count);
}
