/**
 * Pratt parser for formulas, with Excel's operator precedence:
 *
 *   :            range
 *   - +          unary (so -2^2 = 4, as in Excel)
 *   %            postfix percent
 *   ^            power (left-associative)
 *   * /
 *   + -
 *   &            concatenation
 *   = <> < > <= >=
 */

import type { ErrorCode } from '../values';
import { FormulaSyntaxError, tokenize, type RefToken, type Token } from './lexer';

export type AstNode =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'error'; code: ErrorCode }
  | { type: 'ref'; ref: RefToken }
  | { type: 'name'; name: string }
  | { type: 'call'; name: string; args: AstNode[] }
  /** An omitted argument, as in IF(A1,,0). */
  | { type: 'empty' }
  | { type: 'unary'; op: '+' | '-'; arg: AstNode }
  | { type: 'percent'; arg: AstNode }
  | { type: 'binary'; op: BinaryOp; left: AstNode; right: AstNode }
  | { type: 'array'; rows: AstNode[][] };

export type BinaryOp = ':' | '^' | '*' | '/' | '+' | '-' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=';

const BINARY_PRECEDENCE: Record<BinaryOp, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
  ':': 8,
};
const PERCENT_PRECEDENCE = 6;
const UNARY_PRECEDENCE = 7;

export { FormulaSyntaxError };

export function parseFormula(src: string): AstNode {
  const text = src.startsWith('=') ? src.slice(1) : src;
  const tokens = tokenize(text).filter((t) => t.type !== 'ws');
  const parser = new Parser(tokens, text.length);
  const node = parser.expression(0);
  parser.expectEnd();
  return node;
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly length: number,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new FormulaSyntaxError('Unexpected end of formula', this.length);
    return t;
  }

  expectEnd(): void {
    const t = this.peek();
    if (t) throw new FormulaSyntaxError('Unexpected input', t.start);
  }

  expression(minPrec: number): AstNode {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== 'op') break;
      if (t.value === '%') {
        if (PERCENT_PRECEDENCE < minPrec) break;
        this.pos++;
        left = { type: 'percent', arg: left };
        continue;
      }
      const op = t.value as BinaryOp;
      const prec = BINARY_PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      this.pos++;
      // All binary operators are left-associative in Excel, '^' included.
      const right = this.expression(prec + 1);
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private prefix(): AstNode {
    const t = this.next();
    switch (t.type) {
      case 'number':
        return { type: 'number', value: t.value };
      case 'string':
        return { type: 'string', value: t.value };
      case 'error':
        return { type: 'error', code: t.value };
      case 'ref':
        return { type: 'ref', ref: t.ref };
      case 'name': {
        const upper = t.value.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE') return { type: 'boolean', value: upper === 'TRUE' };
        return { type: 'name', name: t.value };
      }
      case 'func':
        return this.call(t.value);
      case 'op':
        if (t.value === '-' || t.value === '+') {
          return { type: 'unary', op: t.value, arg: this.expression(UNARY_PRECEDENCE) };
        }
        throw new FormulaSyntaxError(`Unexpected operator '${t.value}'`, t.start);
      case 'paren':
        if (t.value === '(') {
          const inner = this.expression(0);
          const close = this.next();
          if (close.type !== 'paren' || close.value !== ')') {
            throw new FormulaSyntaxError("Expected ')'", close.start);
          }
          return inner;
        }
        throw new FormulaSyntaxError("Unexpected ')'", t.start);
      case 'brace':
        if (t.value === '{') return this.arrayConstant();
        throw new FormulaSyntaxError("Unexpected '}'", t.start);
      default:
        throw new FormulaSyntaxError('Unexpected token', t.start);
    }
  }

  private call(name: string): AstNode {
    const open = this.next();
    if (open.type !== 'paren' || open.value !== '(') {
      throw new FormulaSyntaxError("Expected '('", open.start);
    }
    const args: AstNode[] = [];
    const first = this.peek();
    if (first && first.type === 'paren' && first.value === ')') {
      this.pos++;
      return { type: 'call', name: stripFuturePrefix(name), args };
    }
    for (;;) {
      const t = this.peek();
      if (t && (t.type === 'comma' || (t.type === 'paren' && t.value === ')'))) {
        args.push({ type: 'empty' });
      } else {
        args.push(this.expression(0));
      }
      const sep = this.next();
      if (sep.type === 'comma') continue;
      if (sep.type === 'paren' && sep.value === ')') break;
      throw new FormulaSyntaxError("Expected ',' or ')'", sep.start);
    }
    return { type: 'call', name: stripFuturePrefix(name), args };
  }

  private arrayConstant(): AstNode {
    const rows: AstNode[][] = [[]];
    for (;;) {
      const row = rows[rows.length - 1]!;
      row.push(this.arrayItem());
      const sep = this.next();
      if (sep.type === 'comma') continue;
      if (sep.type === 'semicolon') {
        rows.push([]);
        continue;
      }
      if (sep.type === 'brace' && sep.value === '}') break;
      throw new FormulaSyntaxError("Expected ',', ';' or '}'", sep.start);
    }
    const width = rows[0]!.length;
    if (rows.some((r) => r.length !== width)) {
      throw new FormulaSyntaxError('Array rows must have the same length', 0);
    }
    return { type: 'array', rows };
  }

  private arrayItem(): AstNode {
    const t = this.next();
    if (t.type === 'number') return { type: 'number', value: t.value };
    if (t.type === 'string') return { type: 'string', value: t.value };
    if (t.type === 'error') return { type: 'error', code: t.value };
    if (t.type === 'name' && /^(TRUE|FALSE)$/i.test(t.value)) {
      return { type: 'boolean', value: t.value.toUpperCase() === 'TRUE' };
    }
    if (t.type === 'op' && t.value === '-') {
      const num = this.next();
      if (num.type === 'number') return { type: 'number', value: -num.value };
    }
    throw new FormulaSyntaxError('Array constants may only hold literals', t.start);
  }
}

/** xlsx stores newer functions as _xlfn.XLOOKUP; we evaluate them by their plain name. */
function stripFuturePrefix(name: string): string {
  return name.replace(/^_XLFN\.(_XLWS\.)?/, '');
}
