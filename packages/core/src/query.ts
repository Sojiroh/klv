// Lenguaje de consulta de logs (estilo Datadog). Módulo puro: sin imports de Node, también se empaqueta en el navegador.
import { LEVEL_PRIORITY, parseLevel } from './log-parser.js';
import type { LogLevel, ParsedLog } from './log-parser.js';

export type ReservedField =
  | 'level'
  | 'service'
  | 'env'
  | 'version'
  | 'pod'
  | 'container'
  | 'namespace'
  | 'trace'
  | 'span'
  | 'caller'
  | 'message'
  | 'error';

export type QueryField = { kind: 'reserved'; name: ReservedField } | { kind: 'attr'; path: string };

export type QueryNode =
  | { type: 'and'; children: QueryNode[] }
  | { type: 'or'; children: QueryNode[] }
  | { type: 'not'; child: QueryNode }
  | { type: 'text'; value: string; wildcard: boolean }
  | { type: 'field'; field: QueryField; op: 'eq'; value: string; wildcard: boolean }
  | { type: 'field'; field: QueryField; op: 'exists' }
  | { type: 'field'; field: QueryField; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number | string }
  | { type: 'field'; field: QueryField; op: 'range'; min: number; max: number };

export type QueryParseResult =
  | { ok: true; ast: QueryNode | null }
  | { ok: false; error: string; position: number };

export interface QueryableLog extends ParsedLog {
  container?: string;
  namespace?: string;
}

// Alias de atributos de Datadog (dd.*): equivalen al campo reservado correspondiente.
const DD_FIELDS: Record<string, ReservedField> = {
  'dd.trace_id': 'trace',
  'dd.span_id': 'span',
  'dd.service': 'service',
  'dd.env': 'env',
  'dd.version': 'version',
};

const RESERVED_FIELDS: Record<string, ReservedField> = {
  ...DD_FIELDS,
  level: 'level',
  status: 'level',
  service: 'service',
  env: 'env',
  version: 'version',
  pod: 'pod',
  container: 'container',
  namespace: 'namespace',
  ns: 'namespace',
  trace: 'trace',
  trace_id: 'trace',
  traceid: 'trace',
  span: 'span',
  span_id: 'span',
  spanid: 'span',
  caller: 'caller',
  message: 'message',
  msg: 'message',
  error: 'error',
};

const KEYWORDS: Record<string, true> = { AND: true, OR: true, NOT: true };
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const RANGE_RE = /\[\s*(-?\d+(?:\.\d+)?)\s+TO\s+(-?\d+(?:\.\d+)?)\s*\]/y;
const WHITESPACE_RE = /\s/;

// ---------------------------------------------------------------------------
// Análisis sintáctico
// ---------------------------------------------------------------------------

class ParseError extends Error {
  constructor(
    message: string,
    readonly position: number
  ) {
    super(message);
  }
}

type Token =
  | { kind: 'lparen' | 'rparen' | 'and' | 'or' | 'not' | 'neg' | 'eof'; pos: number }
  | { kind: 'term'; pos: number; node: QueryNode };

function tokenLabel(token: Token): string {
  switch (token.kind) {
    case 'and':
      return 'AND';
    case 'or':
      return 'OR';
    case 'not':
      return 'NOT';
    default:
      return '-';
  }
}

function resolveFieldName(head: string): QueryField | undefined {
  const lower = head.toLowerCase();
  if (head.length > 1 && head.startsWith('@')) {
    const dd = lower.slice(1);
    return Object.hasOwn(DD_FIELDS, dd) ? { kind: 'reserved', name: DD_FIELDS[dd] } : { kind: 'attr', path: head.slice(1) };
  }
  return Object.hasOwn(RESERVED_FIELDS, lower) ? { kind: 'reserved', name: RESERVED_FIELDS[lower] } : undefined;
}

function isLevelField(field: QueryField): boolean {
  return field.kind === 'reserved' && field.name === 'level';
}

function normalizeLevel(value: string, position: number): LogLevel {
  const isUnknown = value.trim().toLowerCase() === 'unknown';
  const level = isUnknown ? 'UNKNOWN' : parseLevel(value);
  if (level === 'UNKNOWN' && !isUnknown) {
    throw new ParseError(
      `Nivel no válido: "${value}". Válidos: TRACE, DEBUG, INFO, WARN, ERROR, FATAL, UNKNOWN`,
      position
    );
  }
  return level;
}

class Lexer {
  private index = 0;
  private lookahead: Token | undefined;

  constructor(private readonly text: string) {}

  peek(): Token {
    this.lookahead ??= this.scan();
    return this.lookahead;
  }

  next(): Token {
    const token = this.peek();
    this.lookahead = undefined;
    return token;
  }

  private scan(): Token {
    const { text } = this;
    while (this.index < text.length && WHITESPACE_RE.test(text[this.index])) this.index++;
    const pos = this.index;
    if (pos >= text.length) return { kind: 'eof', pos };

    const char = text[pos];
    if (char === '(') {
      this.index++;
      return { kind: 'lparen', pos };
    }
    if (char === ')') {
      this.index++;
      return { kind: 'rparen', pos };
    }
    if (char === '-') {
      if (pos + 1 >= text.length || WHITESPACE_RE.test(text[pos + 1])) {
        throw new ParseError("Falta el término después de '-'", pos);
      }
      this.index++;
      return { kind: 'neg', pos };
    }
    if (char === '"') {
      const { value, end } = this.readQuoted(pos);
      if (value === '') throw new ParseError('La frase entre comillas está vacía', pos);
      this.index = end;
      return { kind: 'term', pos, node: { type: 'text', value, wildcard: false } };
    }

    const end = this.wordEnd(pos);
    const raw = text.slice(pos, end);
    if (Object.hasOwn(KEYWORDS, raw)) {
      this.index = end;
      return { kind: raw.toLowerCase() as 'and' | 'or' | 'not', pos };
    }

    const colon = this.findColon(pos, end);
    const field = colon === -1 ? undefined : this.fieldFromHead(pos, colon);
    if (colon !== -1 && field) {
      const node = this.parseFieldValue(field, text.slice(pos, colon), colon + 1);
      return { kind: 'term', pos, node };
    }

    const { value, wildcard } = this.unescape(pos, end);
    this.index = end;
    return { kind: 'term', pos, node: { type: 'text', value, wildcard } };
  }

  // Fin de una palabra sin comillas: espacio o paréntesis; `\` escapa el carácter siguiente
  private wordEnd(start: number): number {
    const { text } = this;
    let j = start;
    while (j < text.length) {
      const char = text[j];
      if (char === '\\' && j + 1 < text.length) {
        j += 2;
        continue;
      }
      if (WHITESPACE_RE.test(char) || char === '(' || char === ')') break;
      j++;
    }
    return j;
  }

  private findColon(start: number, end: number): number {
    const { text } = this;
    for (let j = start; j < end; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === ':') return j;
    }
    return -1;
  }

  private fieldFromHead(start: number, colon: number): QueryField | undefined {
    const head = this.text.slice(start, colon);
    return head.includes('\\') ? undefined : resolveFieldName(head);
  }

  // Valor sin comillas: `\` escapa el siguiente carácter; `*` sin escapar es comodín
  private unescape(start: number, end: number): { value: string; wildcard: boolean } {
    const { text } = this;
    let value = '';
    let wildcard = false;
    let literalStar = false;
    for (let j = start; j < end; j++) {
      const char = text[j];
      if (char === '\\' && j + 1 < end) {
        j++;
        if (text[j] === '*') literalStar = true;
        value += text[j];
      } else {
        if (char === '*') wildcard = true;
        value += char;
      }
    }
    if (wildcard && literalStar) {
      throw new ParseError("No se puede mezclar '*' literal y comodín en un mismo valor; use comillas", start);
    }
    return { value, wildcard };
  }

  // Cadena entre comillas: solo `\"` y `\\` son escapes; cualquier otra barra se conserva
  private readQuoted(start: number): { value: string; end: number } {
    const { text } = this;
    let value = '';
    for (let j = start + 1; j < text.length; j++) {
      const char = text[j];
      if (char === '\\' && (text[j + 1] === '"' || text[j + 1] === '\\')) {
        value += text[j + 1];
        j++;
      } else if (char === '"') {
        return { value, end: j + 1 };
      } else {
        value += char;
      }
    }
    throw new ParseError('Comillas sin cerrar', start);
  }

  private parseFieldValue(field: QueryField, name: string, start: number): QueryNode {
    const { text } = this;
    const char = text[start];
    if (char === undefined || WHITESPACE_RE.test(char) || char === '(' || char === ')') {
      throw new ParseError(`Falta el valor del campo "${name}"`, start);
    }

    if (char === '"') {
      const { value, end } = this.readQuoted(start);
      if (value === '') throw new ParseError(`Falta el valor del campo "${name}"`, start);
      this.index = end;
      return this.eqNode(field, value, false, start);
    }

    if (char === '[') {
      if (isLevelField(field)) {
        throw new ParseError('El campo level no admite rangos; use comparadores como level:>=warn', start);
      }
      RANGE_RE.lastIndex = start;
      const match = RANGE_RE.exec(text);
      if (!match) throw new ParseError('Rango no válido; use [A TO B] con números', start);
      const min = Number(match[1]);
      const max = Number(match[2]);
      if (min > max) throw new ParseError('Rango no válido: el mínimo es mayor que el máximo', start);
      this.index = start + match[0].length;
      return { type: 'field', field, op: 'range', min, max };
    }

    if (char === '>' || char === '<') {
      const orEqual = text[start + 1] === '=';
      const op = char === '>' ? (orEqual ? 'gte' : 'gt') : orEqual ? 'lte' : 'lt';
      const operandStart = start + (orEqual ? 2 : 1);
      const end = this.wordEnd(operandStart);
      const operand = text.slice(operandStart, end);
      if (operand === '') throw new ParseError('Falta el valor del comparador', start);
      let value: number | string;
      if (isLevelField(field)) {
        const level = normalizeLevel(operand, start);
        if (level === 'UNKNOWN') throw new ParseError('Comparador no válido para el nivel UNKNOWN', start);
        value = level;
      } else {
        if (!NUMBER_RE.test(operand)) {
          throw new ParseError(`Comparador no válido: "${operand}" no es un número`, start);
        }
        value = Number(operand);
      }
      this.index = end;
      return { type: 'field', field, op, value };
    }

    const end = this.wordEnd(start);
    this.index = end;
    if (text.slice(start, end) === '*') return { type: 'field', field, op: 'exists' };
    const { value, wildcard } = this.unescape(start, end);
    return this.eqNode(field, value, wildcard, start);
  }

  private eqNode(field: QueryField, value: string, wildcard: boolean, position: number): QueryNode {
    if (isLevelField(field)) {
      return { type: 'field', field, op: 'eq', value: normalizeLevel(value, position), wildcard: false };
    }
    return { type: 'field', field, op: 'eq', value, wildcard };
  }
}

class Parser {
  private readonly lexer: Lexer;

  constructor(text: string) {
    this.lexer = new Lexer(text);
  }

  parse(): QueryNode {
    const node = this.parseOr();
    const token = this.lexer.next();
    if (token.kind === 'rparen') throw new ParseError('Paréntesis de cierre sin abrir', token.pos);
    return node;
  }

  private parseOr(after?: Token): QueryNode {
    const first = this.parseAnd(after);
    const children = [first];
    while (this.lexer.peek().kind === 'or') {
      const token = this.lexer.next();
      children.push(this.parseAnd(token));
    }
    return children.length === 1 ? first : { type: 'or', children };
  }

  private parseAnd(after?: Token): QueryNode {
    const first = this.parseUnary(after);
    const children = [first];
    for (;;) {
      const { kind } = this.lexer.peek();
      if (kind === 'or' || kind === 'rparen' || kind === 'eof') break;
      if (kind === 'and') {
        const token = this.lexer.next();
        children.push(this.parseUnary(token));
      } else {
        children.push(this.parseUnary());
      }
    }
    return children.length === 1 ? first : { type: 'and', children };
  }

  private parseUnary(after?: Token): QueryNode {
    const token = this.lexer.next();
    switch (token.kind) {
      case 'not':
      case 'neg':
        return { type: 'not', child: this.parseUnary(token) };
      case 'term':
        return token.node;
      case 'lparen': {
        const following = this.lexer.peek();
        if (following.kind === 'rparen') throw new ParseError('Grupo vacío ()', token.pos);
        if (following.kind === 'eof') throw new ParseError('Paréntesis sin cerrar', token.pos);
        const inner = this.parseOr();
        if (this.lexer.next().kind !== 'rparen') throw new ParseError('Paréntesis sin cerrar', token.pos);
        return inner;
      }
      default:
        if (after) {
          throw new ParseError(`Falta el término después de '${tokenLabel(after)}'`, after.pos);
        }
        if (token.kind === 'rparen') throw new ParseError('Paréntesis de cierre sin abrir', token.pos);
        if (token.kind === 'eof') throw new ParseError('Se esperaba un término', token.pos);
        throw new ParseError(`Falta el término antes de '${tokenLabel(token)}'`, token.pos);
    }
  }
}

export function parseQuery(text: string): QueryParseResult {
  if (text.trim() === '') return { ok: true, ast: null };
  try {
    return { ok: true, ast: new Parser(text).parse() };
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: err.message, position: err.position };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------

const globCache = new WeakMap<QueryNode, RegExp>();

function globRegExp(node: QueryNode, glob: string, anchored: boolean): RegExp {
  let regex = globCache.get(node);
  if (!regex) {
    const body = glob
      .split(/\*+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    regex = new RegExp(anchored ? `^${body}$` : body, 'is');
    globCache.set(node, regex);
  }
  return regex;
}

function resolveAttribute(extra: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(extra, path) && extra[path] != null) return extra[path];
  let current: unknown = extra;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? undefined;
}

function resolveField(log: QueryableLog, field: QueryField): unknown {
  if (field.kind === 'attr') return resolveAttribute(log.extra, field.path);
  switch (field.name) {
    case 'pod':
      return log.podName;
    case 'trace':
      return log.traceId;
    case 'span':
      return log.spanId;
    default:
      return log[field.name];
  }
}

function scalarString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

// Formas de texto de un valor: los arreglos aportan un elemento por cada uno de sus elementos
function valueStrings(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map(scalarString).filter((s): s is string => s !== undefined);
}

function valueNumbers(value: unknown): number[] {
  const items = Array.isArray(value) ? value : [value];
  const numbers: number[] = [];
  for (const item of items) {
    if (typeof item === 'number' && Number.isFinite(item)) numbers.push(item);
    else if (typeof item === 'string' && NUMBER_RE.test(item)) numbers.push(Number(item));
  }
  return numbers;
}

function compare(op: 'gt' | 'gte' | 'lt' | 'lte', left: number, right: number): boolean {
  switch (op) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
}

function matchesField(log: QueryableLog, node: Extract<QueryNode, { type: 'field' }>): boolean {
  const isLevel = node.field.kind === 'reserved' && node.field.name === 'level';

  if (isLevel) {
    switch (node.op) {
      case 'eq':
        return log.level === node.value;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return (
          log.level !== 'UNKNOWN' &&
          typeof node.value === 'string' &&
          compare(node.op, LEVEL_PRIORITY[log.level], LEVEL_PRIORITY[node.value as LogLevel])
        );
      case 'exists':
        return log.level !== undefined;
      case 'range':
        return false;
    }
  }

  const value = resolveField(log, node.field);
  switch (node.op) {
    case 'exists':
      return valueStrings(value).some((s) => s !== '');
    case 'eq': {
      const strings = valueStrings(value);
      if (node.wildcard) {
        const regex = globRegExp(node, node.value, true);
        return strings.some((s) => regex.test(s));
      }
      const wanted = node.value.toLowerCase();
      return strings.some((s) => s.toLowerCase() === wanted);
    }
    case 'range':
      return valueNumbers(value).some((n) => n >= node.min && n <= node.max);
    default: {
      const { op } = node;
      const operand = node.value;
      return typeof operand === 'number' && valueNumbers(value).some((n) => compare(op, n, operand));
    }
  }
}

export function matchesQuery(log: QueryableLog, ast: QueryNode | null): boolean {
  if (ast === null) return true;
  let text: string | undefined;
  let lowerText: string | undefined;

  const evaluate = (node: QueryNode): boolean => {
    switch (node.type) {
      case 'and':
        return node.children.every(evaluate);
      case 'or':
        return node.children.some(evaluate);
      case 'not':
        return !evaluate(node.child);
      case 'text':
        // Corpus del texto libre (estilo Datadog): message, error y stack trace, sin vacíos, unidos con
        // `\n`. Los atributos se buscan con `@attr:valor` y los reservados con `campo:valor`.
        // El prefiltro SQL del historial (`message/error/stack_trace ILIKE`) depende de este corpus.
        text ??= [log.message, log.error, log.stackTrace].filter(Boolean).join('\n');
        if (node.wildcard) return globRegExp(node, node.value, false).test(text);
        lowerText ??= text.toLowerCase();
        return lowerText.includes(node.value.toLowerCase());
      case 'field':
        return matchesField(log, node);
    }
  };

  return evaluate(ast);
}

// Valor listo para insertar en una consulta: sin comillas si es un token simple, entre comillas con escapes si no
export function quoteQueryValue(value: string): string {
  if (/^[A-Za-z0-9._\-/@]+$/.test(value) && !Object.hasOwn(KEYWORDS, value)) return value;
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}
