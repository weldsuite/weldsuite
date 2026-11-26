/**
 * `$filter`: a tokenizer and a recursive-descent parser that turn the text into
 * a typed AST. Pure: nothing here knows about SQL (`filter-sql.ts` does that),
 * and the Rust port is written from the same grammar.
 *
 *   or      := and ( 'or' and )*
 *   and     := not ( 'and' not )*
 *   not     := 'not' not | primary
 *   primary := '(' or ')' | operand cmpOp operand | textFn | any
 *   cmpOp   := eq | ne | gt | ge | lt | le
 *   operand := property | literal | year(p) | month(p) | day(p)
 *   textFn  := contains(p, 's') | startswith(p, 's') | endswith(p, 's')
 *   any     := collectionProperty '/any(' v ':' v ' eq ' 's' ')'
 *
 * A comparison has a property (or a date function of one) on one side and a
 * literal on the other, in either order. Property names are resolved against
 * the catalogue; a name that is not in it is a 400. Literals are typed against
 * the property (a mismatch is a 400). Limits: 2 000 characters, nesting depth
 * 10, 30 comparisons.
 */

import { findProperty, type EdmType, type ODataEntitySet, type ODataProperty } from '@weldsuite/desk-domain/odata-catalog';
import { badRequest, notImplemented } from './errors';

export const MAX_FILTER_LENGTH = 2000;
export const MAX_FILTER_DEPTH = 10;
export const MAX_FILTER_COMPARISONS = 30;

export type CmpOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le';
export type DateFn = 'year' | 'month' | 'day';
export type TextFn = 'contains' | 'startswith' | 'endswith';

export type Literal =
  | { type: 'null' }
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'double'; value: number }
  | { type: 'boolean'; value: boolean }
  /** `ts` is `YYYY-MM-DD HH:MM:SS.mmm` in UTC; a bare date has `dayEnd`, the start of the next day. */
  | { type: 'datetime'; ts: string; dayEnd?: string };

export type FilterNode =
  | { kind: 'and' | 'or'; args: FilterNode[] }
  | { kind: 'not'; arg: FilterNode }
  | { kind: 'cmp'; op: CmpOp; prop: ODataProperty; fn?: DateFn; lit: Literal }
  | { kind: 'text'; fn: TextFn; prop: ODataProperty; value: string }
  | { kind: 'any'; prop: ODataProperty; value: string };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { t: '(' | ')' | ',' | ':' | '/' | 'end' }
  | { t: 'string'; v: string }
  | { t: 'int' | 'double'; v: number }
  | { t: 'datetime'; v: Literal & { type: 'datetime' } }
  | { t: 'ident'; v: string };

// A date-time is a date, then a time when one follows, then a zone when one follows the time.
const DATE = /(\d{4})-(\d{2})-(\d{2})/y;
const TIME = /T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?/y;
// A space where the offset's `+` was: an unescaped `+` in a query string reads as a space.
const ZONE = /Z|[+\- ](\d{2}):(\d{2})/y;
const NUMBER = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_]\w*/y;

/** What a sticky expression matches at `at`, or null. */
function matchAt(expression: RegExp, text: string, at: number): RegExpExecArray | null {
  expression.lastIndex = at;
  return expression.exec(text);
}

/** A date-time as written: all of it, and its date, time and zone as matched. */
interface WrittenDateTime {
  text: string;
  date: RegExpExecArray;
  time: RegExpExecArray | null;
  zone: RegExpExecArray | null;
}

/** The date-time that starts at `at`, or null when no date does. */
function readDateTime(text: string, at: number): WrittenDateTime | null {
  const date = matchAt(DATE, text, at);
  if (!date) return null;
  let end = at + date[0].length;
  const time = matchAt(TIME, text, end);
  if (time) end += time[0].length;
  const zone = time ? matchAt(ZONE, text, end) : null;
  if (zone) end += zone[0].length;
  return { text: text.slice(at, end), date, time, zone };
}

/**
 * A moment as `YYYY-MM-DD HH:MM:SS.mmm` in UTC, the year as it is. The day
 * after 9999-12-31 has a year of five digits: `toISOString()` writes that as
 * `+010000`, which the database does not read.
 */
function timestampText(when: Date): string {
  const part = (value: number, width = 2) => String(value).padStart(width, '0');
  const date = `${part(when.getUTCFullYear(), 4)}-${part(when.getUTCMonth() + 1)}-${part(when.getUTCDate())}`;
  const time = `${part(when.getUTCHours())}:${part(when.getUTCMinutes())}:${part(when.getUTCSeconds())}`;
  return `${date} ${time}.${part(when.getUTCMilliseconds(), 3)}`;
}

function dateLiteral(written: WrittenDateTime): Literal & { type: 'datetime' } {
  const [, ys, ms, ds] = written.date;
  const [, hs, mins, ss, frac] = written.time ?? [];
  const [zone, zh, zm] = written.zone ?? [];
  const [y, mo, d] = [Number(ys), Number(ms), Number(ds)];
  const [h, mi, s] = [Number(hs ?? 0), Number(mins ?? 0), Number(ss ?? 0)];
  const milli = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw badRequest(`'${written.text}' is not a valid date or time`);
  }
  probe.setUTCHours(h, mi, s, milli);
  let epoch = probe.getTime();
  if (zone && zone !== 'Z') {
    const offset = (Number(zh) * 60 + Number(zm)) * 60_000;
    epoch += zone.startsWith('-') ? offset : -offset;
  }
  const at = new Date(epoch);
  if (at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999) throw badRequest(`'${written.text}' is out of range`);
  if (hs === undefined) return { type: 'datetime', ts: timestampText(at), dayEnd: timestampText(new Date(epoch + 86_400_000)) };
  return { type: 'datetime', ts: timestampText(at) };
}

/** A token, and where the text goes on after it. */
interface Read {
  token: Token;
  end: number;
}

/** A string literal, from its opening quote at `start`; a doubled quote is a quote. */
function readString(text: string, start: number): Read {
  let value = '';
  let j = start + 1;
  for (;;) {
    if (j >= text.length) throw badRequest('Unterminated string literal in $filter');
    if (text[j] === "'") {
      if (text[j + 1] === "'") {
        value += "'";
        j += 2;
        continue;
      }
      break;
    }
    value += text[j];
    j++;
  }
  // Postgres refuses a NUL in a text parameter, so no stored value holds one.
  if (value.includes('\u0000')) throw badRequest('A string literal in $filter must not contain a NUL character');
  return { token: { t: 'string', v: value }, end: j + 1 };
}

/** Whether a number or a date-time starts at `at`: a digit, or a minus sign before one. */
function startsNumber(text: string, at: number): boolean {
  const ch = text[at]!;
  return /\d/.test(ch) || (ch === '-' && /\d/.test(text[at + 1] ?? ''));
}

function readNumber(text: string, start: number): Read {
  const num = matchAt(NUMBER, text, start)!;
  const value = Number(num[0]);
  const integer = num[1] === undefined && num[2] === undefined;
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) throw badRequest(`'${num[0]}' is out of range`);
  return { token: { t: integer ? 'int' : 'double', v: value }, end: start + num[0].length };
}

/** A date-time, else a number (a negative one is never a date), with nothing glued onto it. */
function readNumberOrDate(text: string, start: number): Read {
  const date = text[start] === '-' ? null : readDateTime(text, start);
  const read: Read = date
    ? { token: { t: 'datetime', v: dateLiteral(date) }, end: start + date.text.length }
    : readNumber(text, start);
  if (/[A-Za-z0-9_.]/.test(text[read.end] ?? '')) throw badRequest(`Unexpected character '${text[read.end]}' in $filter`);
  return read;
}

function readIdent(text: string, start: number): Read {
  const id = matchAt(IDENT, text, start)![0];
  return { token: { t: 'ident', v: id }, end: start + id.length };
}

/** The token that starts at `at`, which is not white space. */
function readToken(text: string, at: number): Read {
  const ch = text[at]!;
  if (ch === '(' || ch === ')' || ch === ',' || ch === ':' || ch === '/') return { token: { t: ch }, end: at + 1 };
  if (ch === "'") return readString(text, at);
  if (startsNumber(text, at)) return readNumberOrDate(text, at);
  if (/[A-Za-z_]/.test(ch)) return readIdent(text, at);
  throw badRequest(`Unexpected character '${ch}' in $filter`);
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ' ' || text[i] === '\t') {
      i++;
    } else {
      const read = readToken(text, i);
      out.push(read.token);
      i = read.end;
    }
  }
  out.push({ t: 'end' });
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const CMP_OPS: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);
const DATE_FNS: ReadonlySet<string> = new Set(['year', 'month', 'day']);
const TEXT_FNS: ReadonlySet<string> = new Set(['contains', 'startswith', 'endswith']);
const FLIP: Record<CmpOp, CmpOp> = { eq: 'eq', ne: 'ne', gt: 'lt', ge: 'le', lt: 'gt', le: 'ge' };

type Operand =
  | { k: 'prop'; prop: ODataProperty }
  | { k: 'func'; fn: DateFn; prop: ODataProperty }
  | { k: 'lit'; lit: Literal }
  | { k: 'pred'; node: FilterNode };

const INT32_MAX = 2_147_483_647;

/** The kinds of literal a type is compared with; null for a collection, which is compared with none. */
function literalTypesFor(type: EdmType): ReadonlyArray<Literal['type']> | null {
  switch (type) {
    case 'Edm.String':
      return ['string'];
    case 'Edm.Int32':
    case 'Edm.Int64':
      return ['int'];
    case 'Edm.Double':
      return ['int', 'double'];
    case 'Edm.Boolean':
      return ['boolean'];
    case 'Edm.DateTimeOffset':
      return ['datetime'];
    default:
      return null;
  }
}

/** The literal, checked against the type it is compared with. */
function checkLiteral(op: CmpOp, name: string, type: EdmType, lit: Literal): Literal {
  const equality = op === 'eq' || op === 'ne';
  if (lit.type === 'null') {
    if (!equality) throw badRequest(`null can only be compared with eq or ne (property '${name}')`);
    return lit;
  }
  const accepted = literalTypesFor(type);
  if (!accepted) throw badRequest(`Property '${name}' is a collection: use ${name}/any(t: t eq 'value')`);
  if (!accepted.includes(lit.type)) throw badRequest(`Cannot compare ${type} '${name}' with a ${lit.type} literal`);
  if (type === 'Edm.Int32' && lit.type === 'int' && Math.abs(lit.value) > INT32_MAX) {
    throw badRequest(`'${lit.value}' does not fit ${type} '${name}'`);
  }
  if (type === 'Edm.Boolean' && !equality) throw badRequest(`Booleans can only be compared with eq or ne (property '${name}')`);
  return lit;
}

class Parser {
  private pos = 0;
  private comparisons = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly set: ODataEntitySet,
  ) {}

  parse(): FilterNode {
    const node = this.or(0);
    if (this.peek().t !== 'end') throw badRequest(`Unexpected ${this.describe(this.peek())} in $filter`);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (token.t !== 'end') this.pos++;
    return token;
  }

  private describe(token: Token): string {
    if (token.t === 'end') return 'end of expression';
    if ('v' in token && typeof token.v === 'string') return `'${token.v}'`;
    return `'${token.t}'`;
  }

  private isIdent(name: string): boolean {
    const token = this.peek();
    return token.t === 'ident' && token.v === name;
  }

  private expect(t: '(' | ')' | ',' | ':'): void {
    const token = this.next();
    if (token.t !== t) throw badRequest(`Expected '${t}' but found ${this.describe(token)} in $filter`);
  }

  private count(): void {
    if (++this.comparisons > MAX_FILTER_COMPARISONS) {
      throw badRequest(`$filter has more than ${MAX_FILTER_COMPARISONS} comparisons`);
    }
  }

  private deeper(depth: number): number {
    if (depth + 1 > MAX_FILTER_DEPTH) throw badRequest(`$filter is nested deeper than ${MAX_FILTER_DEPTH} levels`);
    return depth + 1;
  }

  private or(depth: number): FilterNode {
    const args = [this.and(depth)];
    while (this.isIdent('or')) {
      this.next();
      args.push(this.and(depth));
    }
    return args.length === 1 ? args[0]! : { kind: 'or', args };
  }

  private and(depth: number): FilterNode {
    const args = [this.not(depth)];
    while (this.isIdent('and')) {
      this.next();
      args.push(this.not(depth));
    }
    return args.length === 1 ? args[0]! : { kind: 'and', args };
  }

  private not(depth: number): FilterNode {
    if (this.isIdent('not')) {
      this.next();
      return { kind: 'not', arg: this.not(this.deeper(depth)) };
    }
    return this.primary(depth);
  }

  private primary(depth: number): FilterNode {
    if (this.peek().t === '(') {
      this.next();
      const node = this.or(this.deeper(depth));
      this.expect(')');
      return node;
    }
    const left = this.operand();
    const token = this.peek();
    if (token.t === 'ident' && CMP_OPS.has(token.v)) {
      this.next();
      return this.comparison(token.v as CmpOp, left, this.operand());
    }
    if (left.k === 'pred') return left.node;
    throw badRequest(`Expected a comparison (eq, ne, gt, ge, lt, le) but found ${this.describe(token)} in $filter`);
  }

  private comparison(op: CmpOp, left: Operand, right: Operand): FilterNode {
    if (left.k === 'pred' || right.k === 'pred') throw badRequest('A function result cannot be compared; use the function on its own');
    let subject: Operand = left;
    let lit: Operand = right;
    let operator = op;
    if (left.k === 'lit') {
      subject = right;
      lit = left;
      operator = FLIP[op];
    }
    if (subject.k === 'lit' || lit.k !== 'lit') throw badRequest('A comparison needs a property on one side and a literal on the other');
    this.count();
    const type: EdmType = subject.k === 'func' ? 'Edm.Int32' : subject.prop.type;
    const name = subject.prop.name;
    const checked = checkLiteral(operator, name, type, lit.lit);
    return { kind: 'cmp', op: operator, prop: subject.prop, ...(subject.k === 'func' ? { fn: subject.fn } : {}), lit: checked };
  }

  private property(name: string): ODataProperty {
    const prop = findProperty(this.set, name);
    if (!prop) throw badRequest(`Unknown property '${name}' on ${this.set.name}`);
    if (!prop.filterable) throw badRequest(`Property '${name}' cannot be used in $filter`);
    return prop;
  }

  private operand(): Operand {
    const token = this.next();
    switch (token.t) {
      case 'string':
        return { k: 'lit', lit: { type: 'string', value: token.v } };
      case 'int':
        return { k: 'lit', lit: { type: 'int', value: token.v } };
      case 'double':
        return { k: 'lit', lit: { type: 'double', value: token.v } };
      case 'datetime':
        return { k: 'lit', lit: token.v };
      case 'ident':
        return this.identifier(token.v);
      default:
        throw badRequest(`Unexpected ${this.describe(token)} in $filter`);
    }
  }

  private identifier(name: string): Operand {
    const following = this.peek().t;
    if (following === '(') {
      this.next();
      return this.call(name);
    }
    if (following === '/') {
      return this.path(name);
    }
    if (name === 'true' || name === 'false') return { k: 'lit', lit: { type: 'boolean', value: name === 'true' } };
    if (name === 'null') return { k: 'lit', lit: { type: 'null' } };
    return { k: 'prop', prop: this.property(name) };
  }

  /** A function call, the `(` already consumed. */
  private call(name: string): Operand {
    const isDate = DATE_FNS.has(name);
    if (!isDate && !TEXT_FNS.has(name)) throw notImplemented(`The function '${name}' is not supported in $filter`);
    const arg = this.operand();
    if (arg.k !== 'prop') throw badRequest(`The first argument of ${name}() must be a property`);
    if (isDate) {
      this.expect(')');
      if (arg.prop.type !== 'Edm.DateTimeOffset') throw badRequest(`${name}() needs a date property, '${arg.prop.name}' is ${arg.prop.type}`);
      return { k: 'func', fn: name as DateFn, prop: arg.prop };
    }
    this.expect(',');
    const value = this.operand();
    this.expect(')');
    if (arg.prop.type !== 'Edm.String') throw badRequest(`${name}() needs a string property, '${arg.prop.name}' is ${arg.prop.type}`);
    if (value.k !== 'lit' || value.lit.type !== 'string') throw badRequest(`The second argument of ${name}() must be a string literal`);
    this.count();
    return { k: 'pred', node: { kind: 'text', fn: name as TextFn, prop: arg.prop, value: value.lit.value } };
  }

  /** `property/any(t: t eq 'x')`; every other path is navigation or a lambda we do not run. */
  private path(name: string): Operand {
    const prop = this.property(name);
    this.next();
    const member = this.next();
    if (member.t !== 'ident' || member.v !== 'any' || this.peek().t !== '(') {
      throw notImplemented(`Navigation paths and lambdas other than any() are not supported (${name}/…)`);
    }
    this.next();
    if (prop.type !== 'Collection(Edm.String)') throw badRequest(`any() needs a collection property, '${name}' is ${prop.type}`);
    const variable = this.next();
    if (variable.t === ')') throw notImplemented('any() without a predicate is not supported');
    if (variable.t !== 'ident') throw badRequest('Expected a variable name in any()');
    this.expect(':');
    const again = this.next();
    const op = this.next();
    const value = this.next();
    if (again.t !== 'ident' || again.v !== variable.v || op.t !== 'ident' || op.v !== 'eq') {
      throw notImplemented(`Only any(${variable.v}: ${variable.v} eq 'value') is supported`);
    }
    if (value.t !== 'string') throw badRequest(`any() compares with a string literal, not ${this.describe(value)}`);
    this.expect(')');
    this.count();
    return { k: 'pred', node: { kind: 'any', prop, value: value.v } };
  }
}

/** Parse a `$filter` value against an entity set. Throws `ODataError`. */
export function parseFilter(text: string, set: ODataEntitySet): FilterNode {
  if (text.length > MAX_FILTER_LENGTH) throw badRequest(`$filter is longer than ${MAX_FILTER_LENGTH} characters`);
  if (text.trim() === '') throw badRequest('$filter is empty');
  return new Parser(tokenize(text), set).parse();
}
