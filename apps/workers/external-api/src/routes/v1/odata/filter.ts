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

import { findProperty, type EdmType, type ODataEntitySet, type ODataProperty } from './catalog';
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

// A space where the offset's `+` was: an unescaped `+` in a query string reads as a space.
const DATETIME = /(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+\- ](\d{2}):(\d{2}))?)?/y;
const NUMBER = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

function dateLiteral(m: RegExpExecArray): Literal & { type: 'datetime' } {
  const [, ys, ms, ds, hs, mins, ss, frac, zone, zh, zm] = m;
  const [y, mo, d] = [Number(ys), Number(ms), Number(ds)];
  const [h, mi, s] = [Number(hs ?? 0), Number(mins ?? 0), Number(ss ?? 0)];
  const milli = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw badRequest(`'${m[0]}' is not a valid date or time`);
  }
  probe.setUTCHours(h, mi, s, milli);
  let epoch = probe.getTime();
  if (zone && zone !== 'Z') {
    const offset = (Number(zh) * 60 + Number(zm)) * 60_000;
    epoch += zone.startsWith('-') ? offset : -offset;
  }
  const at = new Date(epoch);
  if (at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999) throw badRequest(`'${m[0]}' is out of range`);
  const text = (when: Date) => `${when.toISOString().slice(0, 10)} ${when.toISOString().slice(11, 23)}`;
  if (hs === undefined) return { type: 'datetime', ts: text(at), dayEnd: text(new Date(epoch + 86_400_000)) };
  return { type: 'datetime', ts: text(at) };
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t') {
      i++;
    } else if (ch === '(' || ch === ')' || ch === ',' || ch === ':' || ch === '/') {
      out.push({ t: ch });
      i++;
    } else if (ch === "'") {
      let value = '';
      let j = i + 1;
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
      out.push({ t: 'string', v: value });
      i = j + 1;
    } else if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
      DATETIME.lastIndex = i;
      const date = ch === '-' ? null : DATETIME.exec(text);
      if (date) {
        out.push({ t: 'datetime', v: dateLiteral(date) });
        i += date[0].length;
      } else {
        NUMBER.lastIndex = i;
        const num = NUMBER.exec(text)!;
        const value = Number(num[0]);
        const integer = num[1] === undefined && num[2] === undefined;
        if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) throw badRequest(`'${num[0]}' is out of range`);
        out.push({ t: integer ? 'int' : 'double', v: value });
        i += num[0].length;
      }
      if (/[A-Za-z0-9_.]/.test(text[i] ?? '')) throw badRequest(`Unexpected character '${text[i]}' in $filter`);
    } else if (/[A-Za-z_]/.test(ch)) {
      IDENT.lastIndex = i;
      const id = IDENT.exec(text)![0];
      out.push({ t: 'ident', v: id });
      i += id.length;
    } else {
      throw badRequest(`Unexpected character '${ch}' in $filter`);
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

/** The literal, checked against the type it is compared with. */
function checkLiteral(op: CmpOp, name: string, type: EdmType, lit: Literal): Literal {
  if (lit.type === 'null') {
    if (op !== 'eq' && op !== 'ne') throw badRequest(`null can only be compared with eq or ne (property '${name}')`);
    return lit;
  }
  const mismatch = () => badRequest(`Cannot compare ${type} '${name}' with a ${lit.type} literal`);
  switch (type) {
    case 'Edm.String':
      if (lit.type !== 'string') throw mismatch();
      return lit;
    case 'Edm.Int32':
      if (lit.type !== 'int') throw mismatch();
      if (Math.abs(lit.value) > INT32_MAX) throw badRequest(`'${lit.value}' does not fit ${type} '${name}'`);
      return lit;
    case 'Edm.Int64':
      if (lit.type !== 'int') throw mismatch();
      return lit;
    case 'Edm.Double':
      if (lit.type !== 'int' && lit.type !== 'double') throw mismatch();
      return lit;
    case 'Edm.Boolean':
      if (lit.type !== 'boolean') throw mismatch();
      if (op !== 'eq' && op !== 'ne') throw badRequest(`Booleans can only be compared with eq or ne (property '${name}')`);
      return lit;
    case 'Edm.DateTimeOffset':
      if (lit.type !== 'datetime') throw mismatch();
      return lit;
    default:
      throw badRequest(`Property '${name}' is a collection: use ${name}/any(t: t eq 'value')`);
  }
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
