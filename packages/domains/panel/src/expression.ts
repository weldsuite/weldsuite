/**
 * Safe arithmetic expressions for WeldPanel: trend formulas (`A / B * 100`,
 * letters are series by index) and computed properties (`price * quantity`,
 * identifiers are event property keys).
 *
 * A small hand-written parser: numbers, identifiers, `+ - * /` (also `−`,
 * `×` and `÷`), unary minus and parentheses. Nothing is ever evaluated with
 * `eval` or `Function`. The same tree is evaluated in JavaScript
 * ({@link evaluate}) or written as SQL ({@link toSql}), where every identifier
 * goes through a resolver the caller supplies (the query compiler turns a
 * property key into `json_get_float(...)` through its own escaping), and
 * division by zero is `NULL` / `null`, never an error or Infinity.
 *
 * No imports, so a client can use it to check a formula as it is typed.
 */

export type ExpressionOperator = '+' | '-' | '*' | '/';

export type ExpressionNode =
  | { type: 'number'; value: number }
  | { type: 'identifier'; name: string }
  | { type: 'negate'; operand: ExpressionNode }
  | { type: 'binary'; operator: ExpressionOperator; left: ExpressionNode; right: ExpressionNode };

/**
 * `series`: single letters `A`–`E` (case-insensitive, returned upper case),
 * one per trends series by index. `properties`: event property keys
 * (`price`, `$lcp`).
 */
export type ExpressionIdentifierKind = 'series' | 'properties';

export interface ParseExpressionOptions {
  identifiers: ExpressionIdentifierKind;
  /** `series` only: how many series the spec has; letters past it are refused. Default 5. */
  seriesCount?: number;
}

export interface ExpressionError {
  message: string;
  /** 0-based offset in the text where the problem is. */
  position: number;
}

export type ParsedExpression =
  | { ok: true; ast: ExpressionNode; /** Distinct identifiers, in order of first use. */ identifiers: string[] }
  | { ok: false; error: ExpressionError };

export const MAX_EXPRESSION_LENGTH = 500;
export const MAX_EXPRESSION_NODES = 100;
export const MAX_EXPRESSION_DEPTH = 20;
/** Largest number literal: keeps every literal in plain decimal notation. */
export const MAX_EXPRESSION_NUMBER = 1e12;
export const SERIES_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

const PROPERTY_IDENTIFIER = /^\$?[A-Za-z_]\w{0,63}$/;

type Token =
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'ident'; name: string; pos: number }
  | { kind: 'op'; op: ExpressionOperator; pos: number }
  | { kind: 'lparen' | 'rparen'; pos: number }
  | { kind: 'end'; pos: number };

class ParseFailure extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

const OPERATOR_CHARS: Record<string, ExpressionOperator> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '*': '*',
  '×': '*',
  '/': '/',
  '÷': '/',
};

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return ch === '$' || ch === '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function readNumber(text: string, start: number): { token: Token; next: number } {
  let i = start;
  while (i < text.length && isDigit(text[i] as string)) i += 1;
  if (text[i] === '.') {
    i += 1;
    const fractionStart = i;
    while (i < text.length && isDigit(text[i] as string)) i += 1;
    if (i === fractionStart) throw new ParseFailure('A number needs digits after the point', i);
  }
  const raw = text.slice(start, i);
  const value = Number(raw);
  if (!Number.isFinite(value) || value > MAX_EXPRESSION_NUMBER) throw new ParseFailure('That number is too large', start);
  if (i < text.length && isIdentStart(text[i] as string)) throw new ParseFailure('Put an operator between a number and a name', i);
  return { token: { kind: 'number', value, pos: start }, next: i };
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function readIdent(text: string, start: number): { token: Token; next: number } {
  let j = start + 1;
  while (j < text.length && isIdentPart(text[j] as string)) j += 1;
  return { token: { kind: 'ident', name: text.slice(start, j), pos: start }, next: j };
}

/** The token at `i` (null for whitespace), and where the next one starts. */
function readToken(text: string, i: number): { token: Token | null; next: number } {
  const ch = text[i] as string;
  if (WHITESPACE.has(ch)) return { token: null, next: i + 1 };
  if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1] ?? ''))) return readNumber(text, i);
  if (isIdentStart(ch)) return readIdent(text, i);
  const op = OPERATOR_CHARS[ch];
  if (op) return { token: { kind: 'op', op, pos: i }, next: i + 1 };
  if (ch === '(') return { token: { kind: 'lparen', pos: i }, next: i + 1 };
  if (ch === ')') return { token: { kind: 'rparen', pos: i }, next: i + 1 };
  throw new ParseFailure(`Unexpected character "${ch}"`, i);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const { token, next } = readToken(text, i);
    if (token) tokens.push(token);
    i = next;
  }
  tokens.push({ kind: 'end', pos: text.length });
  return tokens;
}

class Parser {
  private index = 0;
  private nodes = 0;
  readonly identifiers: string[] = [];

  constructor(
    private readonly tokens: Token[],
    private readonly options: ParseExpressionOptions,
  ) {}

  parse(): ExpressionNode {
    const node = this.expression(0);
    const next = this.peek();
    if (next.kind !== 'end') {
      throw new ParseFailure(next.kind === 'rparen' ? 'Unmatched closing parenthesis' : 'Expected an operator', next.pos);
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private take(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  private count(pos: number): void {
    this.nodes += 1;
    if (this.nodes > MAX_EXPRESSION_NODES) throw new ParseFailure('The formula is too long', pos);
  }

  private guardDepth(depth: number, pos: number): void {
    if (depth > MAX_EXPRESSION_DEPTH) throw new ParseFailure('The formula nests too deeply', pos);
  }

  private expression(depth: number): ExpressionNode {
    let left = this.term(depth);
    for (let next = this.peek(); next.kind === 'op' && (next.op === '+' || next.op === '-'); next = this.peek()) {
      this.take();
      this.count(next.pos);
      left = { type: 'binary', operator: next.op, left, right: this.term(depth) };
    }
    return left;
  }

  private term(depth: number): ExpressionNode {
    let left = this.unary(depth);
    for (let next = this.peek(); next.kind === 'op' && (next.op === '*' || next.op === '/'); next = this.peek()) {
      this.take();
      this.count(next.pos);
      left = { type: 'binary', operator: next.op, left, right: this.unary(depth) };
    }
    return left;
  }

  private unary(depth: number): ExpressionNode {
    const next = this.peek();
    if (next.kind === 'op' && (next.op === '-' || next.op === '+')) {
      this.take();
      this.guardDepth(depth + 1, next.pos);
      const operand = this.unary(depth + 1);
      if (next.op === '+') return operand;
      this.count(next.pos);
      return { type: 'negate', operand };
    }
    return this.primary(depth);
  }

  private primary(depth: number): ExpressionNode {
    const token = this.take();
    switch (token.kind) {
      case 'number':
        this.count(token.pos);
        return { type: 'number', value: token.value };
      case 'ident':
        this.count(token.pos);
        return { type: 'identifier', name: this.identifier(token.name, token.pos) };
      case 'lparen': {
        this.guardDepth(depth + 1, token.pos);
        const inner = this.expression(depth + 1);
        const close = this.take();
        if (close.kind !== 'rparen') throw new ParseFailure('Missing closing parenthesis', close.pos);
        return inner;
      }
      case 'end':
        throw new ParseFailure('The formula ends too early', token.pos);
      case 'rparen':
        throw new ParseFailure('Unexpected closing parenthesis', token.pos);
      default:
        throw new ParseFailure('Expected a number, a name or "("', token.pos);
    }
  }

  private identifier(raw: string, pos: number): string {
    let name: string;
    if (this.options.identifiers === 'series') {
      const letter = raw.toUpperCase();
      const index = SERIES_LETTERS.indexOf(letter as (typeof SERIES_LETTERS)[number]);
      const count = Math.min(Math.max(this.options.seriesCount ?? SERIES_LETTERS.length, 0), SERIES_LETTERS.length);
      if (raw.length !== 1 || index === -1) throw new ParseFailure('Use the letters A to E for the series', pos);
      if (index >= count) throw new ParseFailure(`There is no series ${letter}`, pos);
      name = letter;
    } else {
      if (!PROPERTY_IDENTIFIER.test(raw)) throw new ParseFailure(`"${raw.slice(0, 70)}" is not a property name`, pos);
      name = raw;
    }
    if (!this.identifiers.includes(name)) this.identifiers.push(name);
    return name;
  }
}

/**
 * Parses `text`. Never throws: a formula that does not parse is `{ ok: false }`
 * with a message and the offset of the problem.
 */
export function parseExpression(text: string, options: ParseExpressionOptions): ParsedExpression {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: { message: 'Enter a formula', position: 0 } };
  if (text.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: { message: `Use at most ${MAX_EXPRESSION_LENGTH} characters`, position: MAX_EXPRESSION_LENGTH } };
  }
  try {
    const parser = new Parser(tokenize(text), options);
    const ast = parser.parse();
    return { ok: true, ast, identifiers: parser.identifiers };
  } catch (err) {
    if (err instanceof ParseFailure) return { ok: false, error: { message: err.message, position: err.position } };
    throw err;
  }
}

/** The 0-based series index of a letter (`A` → 0), or -1. */
export function seriesIndex(letter: string): number {
  return SERIES_LETTERS.indexOf(letter.toUpperCase() as (typeof SERIES_LETTERS)[number]);
}

/** Every identifier in the tree, distinct, in order of first use. */
export function expressionIdentifiers(ast: ExpressionNode): string[] {
  const out: string[] = [];
  const walk = (node: ExpressionNode): void => {
    if (node.type === 'identifier') {
      if (!out.includes(node.name)) out.push(node.name);
    } else if (node.type === 'negate') {
      walk(node.operand);
    } else if (node.type === 'binary') {
      walk(node.left);
      walk(node.right);
    }
  };
  walk(ast);
  return out;
}

/**
 * The value of the tree. A missing or non-numeric identifier, division by zero
 * or a result that is not finite gives `null`.
 */
export function evaluate(ast: ExpressionNode, values: Readonly<Record<string, number | null | undefined>>): number | null {
  switch (ast.type) {
    case 'number':
      return ast.value;
    case 'identifier': {
      const value = values[ast.name];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    case 'negate': {
      const value = evaluate(ast.operand, values);
      return value === null ? null : -value;
    }
    case 'binary': {
      const left = evaluate(ast.left, values);
      const right = evaluate(ast.right, values);
      return left === null || right === null ? null : apply(ast.operator, left, right);
    }
  }
}

/** One operation; division by zero and non-finite results are null. */
function apply(operator: ExpressionOperator, left: number, right: number): number | null {
  if (operator === '/' && right === 0) return null;
  const results: Record<ExpressionOperator, () => number> = {
    '+': () => left + right,
    '-': () => left - right,
    '*': () => left * right,
    '/': () => left / right,
  };
  const result = results[operator]();
  return Number.isFinite(result) ? result : null;
}

/** A number literal in plain decimal notation, always with a point so SQL engines divide as floating point. */
function sqlNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_EXPRESSION_NUMBER) throw new RangeError('Number out of range');
  if (Number.isInteger(value)) return `${value}.0`;
  const text = String(value);
  if (!text.includes('e')) return text;
  let fixed = value.toFixed(20);
  while (fixed.endsWith('0')) fixed = fixed.slice(0, -1);
  return fixed;
}

/**
 * The tree as a SQL expression. `resolveIdentifier` turns each identifier into
 * SQL (and is where it gets validated and escaped); numbers are written by
 * this function. Division by zero is `NULL` (`NULLIF`).
 */
export function toSql(ast: ExpressionNode, resolveIdentifier: (identifier: string) => string): string {
  switch (ast.type) {
    case 'number':
      return sqlNumber(ast.value);
    case 'identifier':
      return `(${resolveIdentifier(ast.name)})`;
    case 'negate':
      return `(-${toSql(ast.operand, resolveIdentifier)})`;
    case 'binary': {
      const left = toSql(ast.left, resolveIdentifier);
      const right = toSql(ast.right, resolveIdentifier);
      if (ast.operator === '/') return `(${left} / NULLIF(${right}, 0))`;
      return `(${left} ${ast.operator} ${right})`;
    }
  }
}
