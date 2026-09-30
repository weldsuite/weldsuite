/**
 * Formula Engine — client-side parser and evaluator for spreadsheet formulas.
 *
 * Supports:
 * - Cell references (A1, $A$1, A$1, $A1)
 * - Range references (A1:B5)
 * - Arithmetic: + - * / ^ (power)
 * - String concatenation: &
 * - Comparisons: = <> < > <= >=
 * - Built-in functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, etc.
 */

import { colLabel, colIndex } from './types';
import type { CellValue } from './types';

// ---------- Cell Reference Utilities ----------

export interface CellRef {
  col: number;
  row: number;
  absCol: boolean;
  absRow: boolean;
}

export interface RangeRef {
  start: CellRef;
  end: CellRef;
}

const CELL_REF_RE = /^(\$?)([A-Z]+)(\$?)(\d+)$/;

export function parseRef(ref: string): CellRef | null {
  const m = ref.toUpperCase().match(CELL_REF_RE);
  if (!m) return null;
  return {
    col: colIndex(m[2]),
    row: Number.parseInt(m[4], 10) - 1,
    absCol: m[1] === '$',
    absRow: m[3] === '$',
  };
}

export function refToString(ref: CellRef): string {
  const c = ref.absCol ? '$' : '';
  const r = ref.absRow ? '$' : '';
  return `${c}${colLabel(ref.col)}${r}${ref.row + 1}`;
}

export function parseRange(range: string): RangeRef | null {
  const parts = range.split(':');
  if (parts.length !== 2) return null;
  const start = parseRef(parts[0]);
  const end = parseRef(parts[1]);
  if (!start || !end) return null;
  return { start, end };
}

// ---------- Tokenizer ----------

enum TokenType {
  NUMBER,
  STRING,
  CELL_REF,
  RANGE,
  FUNCTION,
  OPERATOR,
  COMPARE,
  LPAREN,
  RPAREN,
  COMMA,
  COLON,
  CONCAT,
  EOF,
}

interface Token {
  type: TokenType;
  value: string;
  numValue?: number;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'));
}

/** Characters allowed inside a cell-reference / function-name word. */
function isWordChar(ch: string | undefined): boolean {
  return ch === '$' || isLetter(ch) || isDigit(ch) || ch === '_';
}

/** Characters allowed in the second half of a range (`A1:B5`). */
function isRangeEndChar(ch: string | undefined): boolean {
  return ch === '$' || isLetter(ch) || isDigit(ch);
}

/**
 * Each scanner inspects `s` at `i`. When it recognises its construct it appends any
 * tokens to `tokens` and returns the index to continue from; otherwise it returns `null`.
 */
type Scanner = (s: string, i: number, tokens: Token[]) => number | null;

function scanWhitespace(s: string, i: number): number | null {
  return s[i] === ' ' || s[i] === '\t' ? i + 1 : null;
}

function scanString(s: string, i: number, tokens: Token[]): number | null {
  if (s[i] !== '"') return null;
  let str = '';
  i++;
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) { str += s[i + 1]; i += 2; }
    else { str += s[i]; i++; }
  }
  i++; // closing quote
  tokens.push({ type: TokenType.STRING, value: str });
  return i;
}

function scanNumber(s: string, i: number, tokens: Token[]): number | null {
  if (!(isDigit(s[i]) || (s[i] === '.' && i + 1 < s.length && isDigit(s[i + 1])))) return null;
  let num = '';
  while (i < s.length && (isDigit(s[i]) || s[i] === '.')) { num += s[i]; i++; }
  tokens.push({ type: TokenType.NUMBER, value: num, numValue: Number.parseFloat(num) });
  return i;
}

function readWhile(s: string, i: number, pred: (ch: string | undefined) => boolean): string {
  let out = '';
  while (i < s.length && pred(s[i])) { out += s[i]; i++; }
  return out;
}

/** Cell ref, function name, range or boolean literal, all of which start with `$` or a letter. */
function scanWord(s: string, i: number, tokens: Token[]): number | null {
  if (!(s[i] === '$' || isLetter(s[i]))) return null;
  const word = readWhile(s, i, isWordChar);
  i += word.length;

  // Check for range: WORD:WORD
  if (i < s.length && s[i] === ':' && parseRef(word)) {
    i++; // skip :
    const word2 = readWhile(s, i, isRangeEndChar);
    tokens.push({ type: TokenType.RANGE, value: `${word}:${word2}` });
    return i + word2.length;
  }

  const isRef = parseRef(word) !== null;

  // Check if it's a function (next char is '(')
  const nextNonSpace = s.substring(i).search(/\S/);
  const nextChar = nextNonSpace >= 0 ? s[i + nextNonSpace] : '';
  if (nextChar === '(' && !isRef) {
    tokens.push({ type: TokenType.FUNCTION, value: word.toUpperCase() });
    return i;
  }

  // Check if it's a cell reference
  if (isRef) {
    tokens.push({ type: TokenType.CELL_REF, value: word.toUpperCase() });
    return i;
  }

  // Otherwise treat as function name or boolean
  const upper = word.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') {
    tokens.push({ type: TokenType.STRING, value: upper });
    return i;
  }
  tokens.push({ type: TokenType.FUNCTION, value: upper });
  return i;
}

/** `<>`, `<=`, `<`, `>=`, `>`. A trailing lone `<` is dropped (as it always was). */
function scanComparison(s: string, i: number, tokens: Token[]): number | null {
  if (s[i] === '<' && i + 1 < s.length) {
    if (s[i + 1] === '>') { tokens.push({ type: TokenType.COMPARE, value: '<>' }); return i + 2; }
    if (s[i + 1] === '=') { tokens.push({ type: TokenType.COMPARE, value: '<=' }); return i + 2; }
    tokens.push({ type: TokenType.COMPARE, value: '<' });
    return i + 1;
  }
  if (s[i] === '>' && i + 1 < s.length && s[i + 1] === '=') {
    tokens.push({ type: TokenType.COMPARE, value: '>=' });
    return i + 2;
  }
  if (s[i] === '>') {
    tokens.push({ type: TokenType.COMPARE, value: '>' });
    return i + 1;
  }
  return null;
}

const SINGLE_CHAR_TOKENS: ReadonlyMap<string, TokenType> = new Map([
  ['(', TokenType.LPAREN],
  [')', TokenType.RPAREN],
  [',', TokenType.COMMA],
  ['+', TokenType.OPERATOR],
  ['-', TokenType.OPERATOR],
  ['*', TokenType.OPERATOR],
  ['/', TokenType.OPERATOR],
  ['^', TokenType.OPERATOR],
  ['&', TokenType.CONCAT],
  ['=', TokenType.COMPARE],
]);

/** Single-char tokens; any other character is skipped. */
function scanSingleChar(s: string, i: number, tokens: Token[]): number {
  const type = SINGLE_CHAR_TOKENS.get(s[i]);
  if (type !== undefined) tokens.push({ type, value: s[i] });
  return i + 1;
}

const SCANNERS: readonly Scanner[] = [scanWhitespace, scanString, scanNumber, scanWord, scanComparison];

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = formula;

  while (i < s.length) {
    let next: number | null = null;
    for (const scan of SCANNERS) {
      next = scan(s, i, tokens);
      if (next !== null) break;
    }
    i = next ?? scanSingleChar(s, i, tokens);
  }

  tokens.push({ type: TokenType.EOF, value: '' });
  return tokens;
}

// ---------- AST ----------

type ASTNode =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'cell'; ref: CellRef }
  | { type: 'range'; range: RangeRef }
  | { type: 'binary'; op: string; left: ASTNode; right: ASTNode }
  | { type: 'unary'; op: string; operand: ASTNode }
  | { type: 'function'; name: string; args: ASTNode[] };

// ---------- Parser (recursive descent) ----------

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos] || { type: TokenType.EOF, value: '' }; }
  private advance(): Token { return this.tokens[this.pos++]; }
  private expect(type: TokenType): Token {
    const t = this.advance();
    if (t.type !== type) throw new Error(`Expected ${TokenType[type]} but got ${TokenType[t.type]}`);
    return t;
  }

  parse(): ASTNode {
    const node = this.parseComparison();
    return node;
  }

  private parseComparison(): ASTNode {
    let left = this.parseConcat();
    while (this.peek().type === TokenType.COMPARE) {
      const op = this.advance().value;
      const right = this.parseConcat();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseConcat(): ASTNode {
    let left = this.parseAddSub();
    while (this.peek().type === TokenType.CONCAT) {
      this.advance();
      const right = this.parseAddSub();
      left = { type: 'binary', op: '&', left, right };
    }
    return left;
  }

  private parseAddSub(): ASTNode {
    let left = this.parseMulDiv();
    while (this.peek().type === TokenType.OPERATOR && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.advance().value;
      const right = this.parseMulDiv();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parsePower();
    while (this.peek().type === TokenType.OPERATOR && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.advance().value;
      const right = this.parsePower();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  private parsePower(): ASTNode {
    let left = this.parseUnary();
    while (this.peek().type === TokenType.OPERATOR && this.peek().value === '^') {
      this.advance();
      const right = this.parseUnary();
      left = { type: 'binary', op: '^', left, right };
    }
    return left;
  }

  private parseUnary(): ASTNode {
    if (this.peek().type === TokenType.OPERATOR && (this.peek().value === '-' || this.peek().value === '+')) {
      const op = this.advance().value;
      const operand = this.parseUnary();
      if (op === '+') return operand;
      return { type: 'unary', op: '-', operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ASTNode {
    const t = this.peek();

    if (t.type === TokenType.NUMBER) {
      this.advance();
      return { type: 'number', value: t.numValue! };
    }

    if (t.type === TokenType.STRING) {
      this.advance();
      if (t.value === 'TRUE') return { type: 'boolean', value: true };
      if (t.value === 'FALSE') return { type: 'boolean', value: false };
      return { type: 'string', value: t.value };
    }

    if (t.type === TokenType.CELL_REF) {
      this.advance();
      const ref = parseRef(t.value)!;
      return { type: 'cell', ref };
    }

    if (t.type === TokenType.RANGE) {
      this.advance();
      const range = parseRange(t.value)!;
      return { type: 'range', range };
    }

    if (t.type === TokenType.FUNCTION) {
      const name = this.advance().value;
      this.expect(TokenType.LPAREN);
      const args: ASTNode[] = [];
      if (this.peek().type !== TokenType.RPAREN) {
        args.push(this.parse());
        while (this.peek().type === TokenType.COMMA) {
          this.advance();
          args.push(this.parse());
        }
      }
      this.expect(TokenType.RPAREN);
      return { type: 'function', name, args };
    }

    if (t.type === TokenType.LPAREN) {
      this.advance();
      const expr = this.parse();
      this.expect(TokenType.RPAREN);
      return expr;
    }

    throw new Error(`Unexpected token: ${t.value}`);
  }
}

// ---------- Evaluator ----------

type CellGetter = (col: number, row: number) => CellValue;
type FormulaError = '#REF!' | '#VALUE!' | '#DIV/0!' | '#NAME?' | '#CIRC!' | '#N/A' | '#ERROR!';

function isError(v: CellValue): v is FormulaError {
  return typeof v === 'string' && v.startsWith('#') && v.endsWith('!') || v === '#N/A' || v === '#NAME?';
}

function toNumber(v: CellValue): number {
  if (v === null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error('#VALUE!');
  return n;
}

function toString(v: CellValue): string {
  if (v === null) return '';
  return String(v);
}

function expandRange(range: RangeRef, getCellValue: CellGetter): CellValue[] {
  const values: CellValue[] = [];
  const minCol = Math.min(range.start.col, range.end.col);
  const maxCol = Math.max(range.start.col, range.end.col);
  const minRow = Math.min(range.start.row, range.end.row);
  const maxRow = Math.max(range.start.row, range.end.row);
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      values.push(getCellValue(c, r));
    }
  }
  return values;
}

function flattenArgs(args: ASTNode[], getCellValue: CellGetter, visited: Set<string>, evalNode: (node: ASTNode, getCellValue: CellGetter, visited: Set<string>) => CellValue): CellValue[] {
  const values: CellValue[] = [];
  for (const arg of args) {
    if (arg.type === 'range') {
      values.push(...expandRange(arg.range, getCellValue));
    } else {
      values.push(evalNode(arg, getCellValue, visited));
    }
  }
  return values;
}

// Built-in functions
const FUNCTIONS: Record<string, (args: ASTNode[], getCellValue: CellGetter, visited: Set<string>, evalNode: (node: ASTNode, getCellValue: CellGetter, visited: Set<string>) => CellValue) => CellValue> = {
  SUM: (args, get, vis, ev) => {
    const vals = flattenArgs(args, get, vis, ev);
    let sum = 0;
    for (const v of vals) {
      if (isError(v)) return v;
      if (v === null || v === '' || typeof v === 'boolean') continue;
      const n = Number(v);
      if (!Number.isNaN(n)) sum += n;
    }
    return sum;
  },

  AVERAGE: (args, get, vis, ev) => {
    const vals = flattenArgs(args, get, vis, ev);
    let sum = 0, count = 0;
    for (const v of vals) {
      if (isError(v)) return v;
      if (v === null || v === '' || typeof v === 'boolean') continue;
      const n = Number(v);
      if (!Number.isNaN(n)) { sum += n; count++; }
    }
    return count === 0 ? '#DIV/0!' : sum / count;
  },

  MIN: (args, get, vis, ev) => {
    const vals = flattenArgs(args, get, vis, ev);
    let min = Infinity;
    for (const v of vals) {
      if (isError(v)) return v;
      if (v === null || v === '' || typeof v === 'boolean') continue;
      const n = Number(v);
      if (!Number.isNaN(n) && n < min) min = n;
    }
    return min === Infinity ? 0 : min;
  },

  MAX: (args, get, vis, ev) => {
    const vals = flattenArgs(args, get, vis, ev);
    let max = -Infinity;
    for (const v of vals) {
      if (isError(v)) return v;
      if (v === null || v === '' || typeof v === 'boolean') continue;
      const n = Number(v);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    return max === -Infinity ? 0 : max;
  },

  COUNT: (args, get, vis, ev) => {
    const vals = flattenArgs(args, get, vis, ev);
    let count = 0;
    for (const v of vals) {
      if (v !== null && v !== '' && !Number.isNaN(Number(v))) count++;
    }
    return count;
  },

  COUNTA: (args, get, vis, ev) => {
    const vals = flattenArgs(args, get, vis, ev);
    let count = 0;
    for (const v of vals) {
      if (v !== null && v !== '') count++;
    }
    return count;
  },

  ABS: (args, get, vis, ev) => {
    const v = ev(args[0], get, vis);
    if (isError(v)) return v;
    return Math.abs(toNumber(v));
  },

  ROUND: (args, get, vis, ev) => {
    const v = toNumber(ev(args[0], get, vis));
    const d = args.length > 1 ? toNumber(ev(args[1], get, vis)) : 0;
    const factor = Math.pow(10, d);
    return Math.round(v * factor) / factor;
  },

  FLOOR: (args, get, vis, ev) => {
    const v = toNumber(ev(args[0], get, vis));
    const sig = args.length > 1 ? toNumber(ev(args[1], get, vis)) : 1;
    if (sig === 0) return '#DIV/0!';
    return Math.floor(v / sig) * sig;
  },

  CEILING: (args, get, vis, ev) => {
    const v = toNumber(ev(args[0], get, vis));
    const sig = args.length > 1 ? toNumber(ev(args[1], get, vis)) : 1;
    if (sig === 0) return '#DIV/0!';
    return Math.ceil(v / sig) * sig;
  },

  MOD: (args, get, vis, ev) => {
    const a = toNumber(ev(args[0], get, vis));
    const b = toNumber(ev(args[1], get, vis));
    if (b === 0) return '#DIV/0!';
    return a % b;
  },

  POWER: (args, get, vis, ev) => {
    const base = toNumber(ev(args[0], get, vis));
    const exp = toNumber(ev(args[1], get, vis));
    return Math.pow(base, exp);
  },

  SQRT: (args, get, vis, ev) => {
    const v = toNumber(ev(args[0], get, vis));
    if (v < 0) return '#VALUE!';
    return Math.sqrt(v);
  },

  IF: (args, get, vis, ev) => {
    const cond = ev(args[0], get, vis);
    if (isError(cond)) return cond;
    const truthy = cond !== false && cond !== 0 && cond !== '' && cond !== null;
    if (truthy) return args.length > 1 ? ev(args[1], get, vis) : true;
    return args.length > 2 ? ev(args[2], get, vis) : false;
  },

  AND: (args, get, vis, ev) => {
    for (const arg of args) {
      const v = ev(arg, get, vis);
      if (isError(v)) return v;
      if (v === false || v === 0 || v === '' || v === null) return false;
    }
    return true;
  },

  OR: (args, get, vis, ev) => {
    for (const arg of args) {
      const v = ev(arg, get, vis);
      if (isError(v)) return v;
      if (v !== false && v !== 0 && v !== '' && v !== null) return true;
    }
    return false;
  },

  NOT: (args, get, vis, ev) => {
    const v = ev(args[0], get, vis);
    if (isError(v)) return v;
    return v === false || v === 0 || v === '' || v === null;
  },

  IFERROR: (args, get, vis, ev) => {
    try {
      const v = ev(args[0], get, vis);
      if (isError(v)) return args.length > 1 ? ev(args[1], get, vis) : '';
      return v;
    } catch {
      return args.length > 1 ? ev(args[1], get, vis) : '';
    }
  },

  CONCATENATE: (args, get, vis, ev) => {
    return args.map(a => toString(ev(a, get, vis))).join('');
  },

  LEFT: (args, get, vis, ev) => {
    const str = toString(ev(args[0], get, vis));
    const n = args.length > 1 ? toNumber(ev(args[1], get, vis)) : 1;
    return str.substring(0, n);
  },

  RIGHT: (args, get, vis, ev) => {
    const str = toString(ev(args[0], get, vis));
    const n = args.length > 1 ? toNumber(ev(args[1], get, vis)) : 1;
    return str.substring(str.length - n);
  },

  MID: (args, get, vis, ev) => {
    const str = toString(ev(args[0], get, vis));
    const start = toNumber(ev(args[1], get, vis));
    const len = toNumber(ev(args[2], get, vis));
    return str.substring(start - 1, start - 1 + len);
  },

  LEN: (args, get, vis, ev) => {
    return toString(ev(args[0], get, vis)).length;
  },

  UPPER: (args, get, vis, ev) => {
    return toString(ev(args[0], get, vis)).toUpperCase();
  },

  LOWER: (args, get, vis, ev) => {
    return toString(ev(args[0], get, vis)).toLowerCase();
  },

  TRIM: (args, get, vis, ev) => {
    return toString(ev(args[0], get, vis)).trim();
  },

  TEXT: (args, get, vis, ev) => {
    const v = ev(args[0], get, vis);
    // Simplified TEXT — just converts to string
    return toString(v);
  },

  VLOOKUP: (args, get, vis, ev) => {
    if (args.length < 3) return '#N/A';
    const lookup = ev(args[0], get, vis);
    if (args[1].type !== 'range') return '#VALUE!';
    const range = args[1].range;
    const colIdx = toNumber(ev(args[2], get, vis)) - 1;
    const exactMatch = args.length > 3 ? ev(args[3], get, vis) === false || ev(args[3], get, vis) === 0 : false;

    const minRow = Math.min(range.start.row, range.end.row);
    const maxRow = Math.max(range.start.row, range.end.row);
    const firstCol = Math.min(range.start.col, range.end.col);

    for (let r = minRow; r <= maxRow; r++) {
      const cellVal = getCellValue(firstCol, r);
      if (exactMatch) {
        if (String(cellVal) === String(lookup)) {
          return getCellValue(firstCol + colIdx, r);
        }
      } else if (Number(cellVal) <= Number(lookup)) {
        // Approximate match: find largest value <= lookup
        return getCellValue(firstCol + colIdx, lastApproxMatchRow(firstCol, r, maxRow, lookup));
      }
    }
    return '#N/A';
  },

  INDEX: (args, get, vis, ev) => {
    if (args.length < 2) return '#REF!';
    if (args[0].type !== 'range') return '#VALUE!';
    const range = args[0].range;
    const rowIdx = toNumber(ev(args[1], get, vis)) - 1;
    const colIdx = args.length > 2 ? toNumber(ev(args[2], get, vis)) - 1 : 0;
    const minRow = Math.min(range.start.row, range.end.row);
    const minCol = Math.min(range.start.col, range.end.col);
    return getCellValue(minCol + colIdx, minRow + rowIdx);
  },

  MATCH: (args, get, vis, ev) => {
    if (args.length < 2) return '#N/A';
    const lookup = ev(args[0], get, vis);
    if (args[1].type !== 'range') return '#VALUE!';
    const range = args[1].range;
    const matchType = args.length > 2 ? toNumber(ev(args[2], get, vis)) : 1;

    const minRow = Math.min(range.start.row, range.end.row);
    const maxRow = Math.max(range.start.row, range.end.row);
    const minCol = Math.min(range.start.col, range.end.col);
    const maxCol = Math.max(range.start.col, range.end.col);

    // Determine if it's a row or column vector
    const isRow = minRow === maxRow;
    const count = isRow ? maxCol - minCol + 1 : maxRow - minRow + 1;
    const cellAt = (i: number): CellValue => (isRow ? getCellValue(minCol + i, minRow) : getCellValue(minCol, minRow + i));

    for (let i = 0; i < count; i++) {
      if (isMatchAt(matchType, lookup, i, count, cellAt)) return i + 1;
    }
    return '#N/A';
  },

  TODAY: () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  NOW: () => {
    return new Date().toISOString();
  },

  DATE: (args, get, vis, ev) => {
    const y = toNumber(ev(args[0], get, vis));
    const m = toNumber(ev(args[1], get, vis));
    const d = toNumber(ev(args[2], get, vis));
    const date = new Date(y, m - 1, d);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },

  YEAR: (args, get, vis, ev) => {
    const v = toString(ev(args[0], get, vis));
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '#VALUE!' : d.getFullYear();
  },

  MONTH: (args, get, vis, ev) => {
    const v = toString(ev(args[0], get, vis));
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '#VALUE!' : d.getMonth() + 1;
  },

  DAY: (args, get, vis, ev) => {
    const v = toString(ev(args[0], get, vis));
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '#VALUE!' : d.getDate();
  },

  COUNTIF: (args, get, vis, ev) => {
    if (args.length < 2) return '#VALUE!';
    if (args[0].type !== 'range') return '#VALUE!';
    const vals = expandRange(args[0].range, getCellValue);
    const criteria = toString(ev(args[1], get, vis));
    let count = 0;
    for (const v of vals) {
      if (matchesCriteria(v, criteria)) count++;
    }
    return count;
  },

  SUMIF: (args, get, vis, ev) => {
    if (args.length < 2) return '#VALUE!';
    if (args[0].type !== 'range') return '#VALUE!';
    const range = args[0].range;
    const criteria = toString(ev(args[1], get, vis));
    const sumRange = args.length > 2 && args[2].type === 'range' ? args[2].range : range;

    const minRow = Math.min(range.start.row, range.end.row);
    const maxRow = Math.max(range.start.row, range.end.row);
    const minCol = Math.min(range.start.col, range.end.col);
    const sumMinRow = Math.min(sumRange.start.row, sumRange.end.row);
    const sumMinCol = Math.min(sumRange.start.col, sumRange.end.col);

    let sum = 0;
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= Math.max(range.start.col, range.end.col); c++) {
        const v = getCellValue(c, r);
        if (matchesCriteria(v, criteria)) {
          const rowOffset = r - minRow;
          const colOffset = c - minCol;
          const sv = getCellValue(sumMinCol + colOffset, sumMinRow + rowOffset);
          const n = Number(sv);
          if (!Number.isNaN(n)) sum += n;
        }
      }
    }
    return sum;
  },

  PI: () => Math.PI,
};

/** VLOOKUP approximate match: the last consecutive row (from `startRow`) whose key is <= lookup. */
function lastApproxMatchRow(firstCol: number, startRow: number, maxRow: number, lookup: CellValue): number {
  let lastMatch = startRow;
  for (let r2 = startRow + 1; r2 <= maxRow; r2++) {
    const v2 = getCellValue(firstCol, r2);
    if (Number(v2) <= Number(lookup)) lastMatch = r2;
    else break;
  }
  return lastMatch;
}

/** MATCH: does position `i` of the lookup vector satisfy the given match type? */
function isMatchAt(
  matchType: number,
  lookup: CellValue,
  i: number,
  count: number,
  cellAt: (i: number) => CellValue,
): boolean {
  const cellVal = cellAt(i);
  if (matchType === 0) return String(cellVal) === String(lookup);
  if (matchType === 1) {
    // Continue until we find the last <= value
    return Number(cellVal) <= Number(lookup) && (i === count - 1 || Number(cellAt(i + 1)) > Number(lookup));
  }
  if (matchType === -1) {
    return Number(cellVal) >= Number(lookup) && (i === count - 1 || Number(cellAt(i + 1)) < Number(lookup));
  }
  return false;
}

function matchesCriteria(value: CellValue, criteria: string): boolean {
  // Criteria can be: "hello", ">5", "<=10", "<>abc", "=test"
  if (criteria.startsWith('>=')) {
    return Number(value) >= Number(criteria.slice(2));
  }
  if (criteria.startsWith('<=')) {
    return Number(value) <= Number(criteria.slice(2));
  }
  if (criteria.startsWith('<>')) {
    return String(value) !== criteria.slice(2);
  }
  if (criteria.startsWith('>')) {
    return Number(value) > Number(criteria.slice(1));
  }
  if (criteria.startsWith('<')) {
    return Number(value) < Number(criteria.slice(1));
  }
  if (criteria.startsWith('=')) {
    return String(value) === criteria.slice(1);
  }
  return String(value) === criteria;
}

// Placeholder stub matching CellGetter's shape; VLOOKUP/INDEX/MATCH/COUNTIF/SUMIF above resolve
// calls to this module-scope declaration via hoisting rather than their own `get` parameter
// (pre-existing behavior, not changed here).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getCellValue(col: number, row: number): CellValue {
  // This is a placeholder - the real getCellValue is passed to evaluate()
  return null;
}

function applyBinaryOp(op: string, left: CellValue, right: CellValue): CellValue {
  switch (op) {
    case '+': return toNumber(left) + toNumber(right);
    case '-': return toNumber(left) - toNumber(right);
    case '*': return toNumber(left) * toNumber(right);
    case '/': {
      const d = toNumber(right);
      if (d === 0) return '#DIV/0!';
      return toNumber(left) / d;
    }
    case '^': return Math.pow(toNumber(left), toNumber(right));
    case '&': return toString(left) + toString(right);
    case '=': return left == right; // loose equality for number/string
    case '<>': return left != right;
    case '<': return toNumber(left) < toNumber(right);
    case '>': return toNumber(left) > toNumber(right);
    case '<=': return toNumber(left) <= toNumber(right);
    case '>=': return toNumber(left) >= toNumber(right);
    default: return '#ERROR!';
  }
}

function evalBinary(
  node: Extract<ASTNode, { type: 'binary' }>,
  getCellValue: CellGetter,
  visited: Set<string>,
): CellValue {
  const left = evalNode(node.left, getCellValue, visited);
  if (isError(left)) return left;
  const right = evalNode(node.right, getCellValue, visited);
  if (isError(right)) return right;
  return applyBinaryOp(node.op, left, right);
}

function evalFunctionCall(
  node: Extract<ASTNode, { type: 'function' }>,
  getCellValue: CellGetter,
  visited: Set<string>,
): CellValue {
  const fn = FUNCTIONS[node.name];
  if (!fn) return '#NAME?';
  try {
    return fn(node.args, getCellValue, visited, evalNode);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : undefined;
    if (message?.startsWith('#')) return message as FormulaError;
    return '#ERROR!';
  }
}

function evalNode(node: ASTNode, getCellValue: CellGetter, visited: Set<string>): CellValue {
  switch (node.type) {
    case 'number': return node.value;
    case 'string': return node.value;
    case 'boolean': return node.value;

    case 'cell': {
      const key = `${node.ref.col},${node.ref.row}`;
      if (visited.has(key)) return '#CIRC!';
      return getCellValue(node.ref.col, node.ref.row);
    }

    case 'range': {
      // When a range appears as a standalone expression, return the first value
      const vals = expandRange(node.range, getCellValue);
      return vals[0] ?? null;
    }

    case 'unary': {
      const operand = evalNode(node.operand, getCellValue, visited);
      if (isError(operand)) return operand;
      if (node.op === '-') return -toNumber(operand);
      return operand;
    }

    case 'binary': return evalBinary(node, getCellValue, visited);

    case 'function': return evalFunctionCall(node, getCellValue, visited);
  }
}

// ---------- Public API ----------

export function isFormula(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('=');
}

export function evaluate(
  formula: string,
  getCellValue: CellGetter,
  visitedCells?: Set<string>
): CellValue {
  if (!formula.startsWith('=')) return formula;
  const expr = formula.substring(1);
  if (!expr.trim()) return '';

  try {
    const tokens = tokenize(expr);
    const parser = new Parser(tokens);
    const ast = parser.parse();
    const visited = visitedCells ?? new Set<string>();
    return evalNode(ast, getCellValue, visited);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : undefined;
    if (message?.startsWith('#')) return message;
    return '#ERROR!';
  }
}

/** Every "col,row" key covered by a range token. */
function rangeDependencies(rangeText: string): string[] {
  const range = parseRange(rangeText);
  if (!range) return [];
  const deps: string[] = [];
  const minCol = Math.min(range.start.col, range.end.col);
  const maxCol = Math.max(range.start.col, range.end.col);
  const minRow = Math.min(range.start.row, range.end.row);
  const maxRow = Math.max(range.start.row, range.end.row);
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      deps.push(`${c},${r}`);
    }
  }
  return deps;
}

function tokenDependencies(t: Token): string[] {
  if (t.type === TokenType.CELL_REF) {
    const ref = parseRef(t.value);
    return ref ? [`${ref.col},${ref.row}`] : [];
  }
  if (t.type === TokenType.RANGE) return rangeDependencies(t.value);
  return [];
}

/**
 * Get the set of cell references that a formula depends on.
 * Returns an array of "col,row" strings.
 */
export function getDependencies(formula: string): string[] {
  if (!isFormula(formula)) return [];
  const deps: string[] = [];
  const expr = formula.substring(1);
  if (!expr.trim()) return deps;

  try {
    const tokens = tokenize(expr);
    for (const t of tokens) {
      // push one by one: spreading a huge range would exceed the call-argument limit
      for (const dep of tokenDependencies(t)) deps.push(dep);
    }
  } catch {
    // Parse error — no deps
  }

  return deps;
}

/**
 * Adjust formula references by delta (for copy/paste and fill).
 * Absolute references ($A$1) are not adjusted.
 */
export function adjustFormula(formula: string, rowDelta: number, colDelta: number): string {
  if (!isFormula(formula)) return formula;
  const expr = formula.substring(1);

  // Replace cell references, preserving $ anchors
  const refRe = /(\$?)([A-Z]+)(\$?)(\d+)/gi;
  const adjusted = expr.replace(refRe, (match, absc, col, absr, row) => {
    const colIdx = colIndex(col.toUpperCase());
    const rowIdx = Number.parseInt(row, 10) - 1;
    const newCol = absc === '$' ? colIdx : Math.max(0, colIdx + colDelta);
    const newRow = absr === '$' ? rowIdx : Math.max(0, rowIdx + rowDelta);
    return `${absc}${colLabel(newCol)}${absr}${newRow + 1}`;
  });

  return '=' + adjusted;
}
