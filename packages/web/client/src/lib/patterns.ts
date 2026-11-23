import type { QueryableLog } from '@klv/query';
import type { LogLevel } from '../types';
import { JOB_CHUNK, type Job } from './job';
import { cachedTime } from './time';

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

interface PatternKey {
  signature: string;
  id: string;
}

/** Bound on the interned keys: a stream of all-different messages must not grow the table forever. */
const MAX_INTERNED_KEYS = 20_000;

// Log objects are immutable once loaded: the signature (8 regexes) is computed once per object, and
// logs sharing a signature share one key object.
const keyCache = new WeakMap<QueryableLog, PatternKey>();
const internedKeys = new Map<string, PatternKey>();

function logKey(log: QueryableLog): PatternKey {
  let key = keyCache.get(log);
  if (key === undefined) {
    const signature = messageSignature(log.message || log.raw);
    key = internedKeys.get(signature);
    if (key === undefined) {
      key = { signature, id: fnv1a(signature) };
      if (internedKeys.size < MAX_INTERNED_KEYS) internedKeys.set(signature, key);
    }
    keyCache.set(log, key);
  }
  return key;
}

export function patternId(log: QueryableLog): string {
  return logKey(log).id;
}

export interface PatternSummary {
  patterns: LogPattern[];
  /** Logs the patterns were computed from. */
  total: number;
}

/** Groups logs by message signature, most frequent first. Single pass. */
export function* patternsJob(logs: QueryableLog[]): Job<PatternSummary> {
  const byId = new Map<string, LogPattern>();

  for (let i = 0; i < logs.length; i++) {
    if ((i & (JOB_CHUNK - 1)) === JOB_CHUNK - 1) yield;
    const log = logs[i];
    const { signature, id } = logKey(log);
    const time = cachedTime(log);

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

  return { patterns: [...byId.values()].sort((a, b) => b.count - a.count), total: logs.length };
}
