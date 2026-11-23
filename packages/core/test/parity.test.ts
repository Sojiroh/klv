import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchesFilter, parseLogLine } from '../src/log-parser.js';
import type { LogFilter } from '../src/log-parser.js';
import { MAX_QUERY_DEPTH, matchesQuery, parseQuery } from '../src/query.js';
import type { QueryNode } from '../src/query.js';

// Los mismos JSON los lee la prueba de paridad de Rust (`src-tauri/src/parser/parity_tests.rs`)
const load = <T>(file: string): T[] =>
  JSON.parse(readFileSync(new URL(`./parity/${file}`, import.meta.url), 'utf8')) as T[];

interface ParserCase {
  name: string;
  line: string;
  pod?: string;
  expected: unknown;
}

interface QueryCase {
  name: string;
  query: string;
  ast: QueryNode;
  line: string;
  context?: { pod?: string; namespace?: string; container?: string };
  matches: boolean;
}

interface FilterCase {
  name: string;
  line: string;
  filter: LogFilter;
  matches: boolean;
}

describe('parser: fixtures compartidos con Rust', () => {
  it.each(load<ParserCase>('parser.json'))('$name', ({ line, pod, expected }) => {
    expect(JSON.parse(JSON.stringify(parseLogLine(line, pod)))).toEqual(expected);
  });
});

describe('consultas: fixtures compartidos con Rust', () => {
  it.each(load<QueryCase>('query.json'))('$name', ({ query, ast, line, context, matches }) => {
    expect(parseQuery(query)).toEqual({ ok: true, ast });
    const log = { ...parseLogLine(line, context?.pod), namespace: context?.namespace, container: context?.container };
    expect(matchesQuery(log, ast)).toBe(matches);
  });
});

describe('filtros: fixtures compartidos con Rust', () => {
  it.each(load<FilterCase>('filter.json'))('$name', ({ line, filter, matches }) => {
    expect(matchesFilter(parseLogLine(line), filter)).toBe(matches);
  });
});

describe('parser', () => {
  it('conserva __proto__ como clave propia sin tocar el prototipo de extra', () => {
    const { extra } = parseLogLine('{"__proto__":{"polluted":1},"x":2}');
    expect(Object.getPrototypeOf(extra)).toBe(Object.prototype);
    expect(Object.hasOwn(extra, '__proto__')).toBe(true);
    expect((extra as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(extra)).toBe('{"__proto__":{"polluted":1},"x":2}');
  });

  it('un nivel con nombre de propiedad de Object no resuelve a una función', () => {
    for (const level of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(parseLogLine(JSON.stringify({ level, message: 'x' })).level).toBe('UNKNOWN');
    }
  });

  it('los ids conservan dígitos exactos también cuando la clave está en un objeto anidado o plana', () => {
    expect(parseLogLine('{"dd":{"trace_id":1234567890123456789}}').traceId).toBe('1234567890123456789');
    expect(parseLogLine('{"trace_id":1234567890123456789}').traceId).toBe('1234567890123456789');
    expect(parseLogLine('{"trace_id":18446744073709551616}').traceId).toBe('18446744073709552000');
  });
});

describe('parseQuery: anidación', () => {
  it('no lanza con paréntesis muy anidados', () => {
    const result = parseQuery('('.repeat(20000) + 'a' + ')'.repeat(20000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/anidación/);
  });

  it('no lanza con cadenas de NOT, guiones ni grupos de valores muy anidados', () => {
    for (const query of ['NOT '.repeat(20000) + 'a', '-'.repeat(20000) + 'a', 'service:' + '('.repeat(20000) + 'a' + ')'.repeat(20000), 'service:(' + 'NOT '.repeat(20000) + 'a)']) {
      expect(parseQuery(query).ok).toBe(false);
    }
  });

  it('acepta hasta MAX_QUERY_DEPTH niveles y rechaza el siguiente', () => {
    expect(MAX_QUERY_DEPTH).toBe(64);
    const depth = (node: QueryNode): number =>
      node.type === 'not' ? 1 + depth(node.child) : node.type === 'and' || node.type === 'or' ? 1 + Math.max(...node.children.map(depth)) : 0;
    const ok = parseQuery('NOT '.repeat(MAX_QUERY_DEPTH) + 'a');
    expect(ok.ok && depth(ok.ast as QueryNode)).toBe(MAX_QUERY_DEPTH);
    expect(parseQuery('NOT '.repeat(MAX_QUERY_DEPTH + 1) + 'a').ok).toBe(false);
    let nested = 'a';
    for (let i = 0; i < 40; i++) nested = `(${nested} OR b${i}) AND c${i}`;
    expect(parseQuery(nested).ok).toBe(false);
    expect(parseQuery('('.repeat(200) + 'a' + ')'.repeat(200))).toEqual(parseQuery('a'));
  });

  it('level: mantiene el error de nivel no válido y los numéricos de pino', () => {
    expect(parseQuery('level:foo').ok).toBe(false);
    expect(parseQuery('level:50')).toEqual(parseQuery('level:error'));
    expect(parseQuery('level:[1 TO 2]').ok).toBe(false);
  });
});

describe('glob', () => {
  // Referencia recursiva obvia (exponencial, solo para textos cortos)
  const reference = (text: string[], pattern: string[], anchored: boolean): boolean => {
    const go = (t: number, p: number): boolean => {
      if (p === pattern.length) return !anchored || t === text.length;
      if (pattern[p] === '*') return go(t, p + 1) || (t < text.length && go(t + 1, p));
      return t < text.length && (pattern[p] === '?' || pattern[p] === text[t]) && go(t + 1, p + 1);
    };
    return anchored ? go(0, 0) : [...Array(text.length + 1).keys()].some((start) => go(start, 0));
  };

  it('coincide con la referencia para patrones y textos aleatorios', () => {
    const alphabet = ['a', 'b', 'A', 'é', '😀'];
    let seed = 12345;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      const text = Array.from({ length: random(7) }, () => alphabet[random(alphabet.length)]);
      const pattern = Array.from({ length: random(6) + 1 }, () => ['a', 'b', 'é', '😀', '*', '?', '*'][random(7)]);
      const glob = pattern.join('');
      const line = JSON.stringify({ service: text.join(''), message: text.join('') });
      const lowerText = text.map((c) => c.toLowerCase());
      const lowerPattern = pattern.map((c) => c.toLowerCase());
      for (const anchored of [true, false]) {
        const node: QueryNode = anchored
          ? { type: 'field', field: { kind: 'reserved', name: 'service' }, op: 'eq', value: glob, wildcard: true }
          : { type: 'text', value: glob, wildcard: true };
        expect(matchesQuery(parseLogLine(line), node)).toBe(reference(lowerText, lowerPattern, anchored));
      }
    }
  });

  it('no es polinómico sobre textos largos', () => {
    const ast = parseQuery('a*a*a*a*a*a*b');
    expect(ast.ok).toBe(true);
    const log = parseLogLine(JSON.stringify({ message: 'a'.repeat(100_000) }));
    const started = performance.now();
    expect(matchesQuery(log, ast.ok ? ast.ast : null)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
