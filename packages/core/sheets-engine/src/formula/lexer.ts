/**
 * Formula tokenizer.
 *
 * Formulas are stored without the leading '=' and in the canonical
 * (en-US) syntax: ',' separates arguments, '.' is the decimal point. Every
 * token keeps its source span, so reference rewriting (row insertion, sheet
 * rename, …) splices new text into the original and leaves the user's
 * spacing and casing alone.
 *
 * A literal reference is lexed as one token, including its sheet prefix and
 * a ':' range part ("'Q1 sales'!$A$1:B20", "A:C", "3:7"), so a range can be
 * adjusted as a unit when rows or columns move.
 */

import { lettersToCol, MAX_COLS, MAX_ROWS } from '../address';
import { isErrorCode, type ErrorCode } from '../values';

export interface RefToken {
  /** Sheet name as written (unquoted), or null for the formula's own sheet. */
  sheet: string | null;
  kind: 'cell' | 'range' | 'cols' | 'rows';
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  absR1: boolean;
  absC1: boolean;
  absR2: boolean;
  absC2: boolean;
}

export type Token =
  | { type: 'number'; value: number; start: number; end: number }
  | { type: 'string'; value: string; start: number; end: number }
  | { type: 'error'; value: ErrorCode; start: number; end: number }
  | { type: 'ref'; ref: RefToken; start: number; end: number }
  | { type: 'name'; value: string; start: number; end: number }
  | { type: 'func'; value: string; start: number; end: number }
  | { type: 'op'; value: string; start: number; end: number }
  | { type: 'paren'; value: '(' | ')'; start: number; end: number }
  | { type: 'brace'; value: '{' | '}'; start: number; end: number }
  | { type: 'comma'; start: number; end: number }
  | { type: 'semicolon'; start: number; end: number }
  | { type: 'ws'; start: number; end: number };

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'FormulaSyntaxError';
  }
}

const OPERATORS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%', ':'];

const SHEET_IDENT = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/;
const CELL_PART = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/;
const COL_PART = /^(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(.!])/;
const ROW_PART = /^(\$?)(\d{1,7})/;
const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const IDENT = /^[A-Za-z_\\À-￿][A-Za-z0-9_.À-￿]*/;

/** What may not follow a cell address, which would then be part of a name, a function call or a sheet prefix. */
const REF_RUNS_ON = /[A-Za-z0-9_(.!]/;

type LexedRef = { ref: RefToken; end: number };

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) i = lexToken(src, i, tokens);
  return tokens;
}

/** Lexes the token at `i` into `tokens`; returns where the next one starts. */
function lexToken(src: string, i: number, tokens: Token[]): number {
  const ch = src[i]!;
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return lexWhitespace(src, i, tokens);
  if (ch === '"') {
    const { text, end } = readQuoted(src, i, 'Unterminated string');
    tokens.push({ type: 'string', value: text, start: i, end });
    return end;
  }
  // Quoted sheet name: 'My sheet'!A1
  if (ch === "'") return lexQuotedSheetRef(src, i, tokens);
  if (ch === '#') return lexErrorLiteral(src, i, tokens);
  const punct = punctuation(ch, i);
  if (punct) {
    tokens.push(punct);
    return i + 1;
  }
  return lexOperand(src, i, tokens);
}

function lexWhitespace(src: string, i: number, tokens: Token[]): number {
  let j = i + 1;
  while (j < src.length && /\s/.test(src[j]!)) j++;
  tokens.push({ type: 'ws', start: i, end: j });
  return j;
}

/**
 * Reads the literal whose opening quote is at `i`; a doubled quote inside it
 * stands for one. Returns the text and the index after the closing quote.
 */
function readQuoted(src: string, i: number, unterminated: string): { text: string; end: number } {
  const quote = src[i]!;
  let j = i + 1;
  let text = '';
  for (;;) {
    if (j >= src.length) throw new FormulaSyntaxError(unterminated, i);
    if (src[j] !== quote) {
      text += src[j];
      j++;
    } else if (src[j + 1] === quote) {
      text += quote;
      j += 2;
    } else {
      return { text, end: j + 1 };
    }
  }
}

function lexQuotedSheetRef(src: string, i: number, tokens: Token[]): number {
  const { text: name, end: j } = readQuoted(src, i, 'Unterminated sheet name');
  if (src[j] !== '!') throw new FormulaSyntaxError("Expected '!' after sheet name", j);
  const ref = lexRefBody(src, j + 1, name);
  if (!ref) throw new FormulaSyntaxError('Expected a reference after sheet name', j + 1);
  return pushRef(tokens, ref, i);
}

function lexErrorLiteral(src: string, i: number, tokens: Token[]): number {
  const m = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!)/i.exec(src.slice(i));
  if (!m) throw new FormulaSyntaxError('Unknown error literal', i);
  const code = m[0].toUpperCase();
  if (!isErrorCode(code)) throw new FormulaSyntaxError('Unknown error literal', i);
  tokens.push({ type: 'error', value: code, start: i, end: i + m[0].length });
  return i + m[0].length;
}

/** Parentheses, braces and separators: single-character tokens. */
function punctuation(ch: string, i: number): Token | null {
  if (ch === '(' || ch === ')') return { type: 'paren', value: ch, start: i, end: i + 1 };
  if (ch === '{' || ch === '}') return { type: 'brace', value: ch, start: i, end: i + 1 };
  if (ch === ',') return { type: 'comma', start: i, end: i + 1 };
  if (ch === ';') return { type: 'semicolon', start: i, end: i + 1 };
  return null;
}

/** Numbers, references, names, function names and operators. */
function lexOperand(src: string, i: number, tokens: Token[]): number {
  const ch = src[i]!;
  const digit = ch >= '0' && ch <= '9';
  // Row range "3:7" / "$3:$7" must be tried before plain numbers.
  const rows = ch === '$' || digit ? lexRowRange(src, i, null) : null;
  if (rows) return pushRef(tokens, rows, i);

  if (digit || (ch === '.' && /\d/.test(src[i + 1] ?? ''))) {
    const m = NUMBER.exec(src.slice(i))!;
    tokens.push({ type: 'number', value: Number(m[0]), start: i, end: i + m[0].length });
    return i + m[0].length;
  }

  // IDENT on a single character tests whether a name can start with it.
  if (ch === '$' || IDENT.test(ch)) {
    const end = lexWord(src, i, tokens);
    if (end !== null) return end;
  }

  const op = OPERATORS.find((o) => src.startsWith(o, i));
  if (!op) throw new FormulaSyntaxError(`Unexpected character '${ch}'`, i);
  tokens.push({ type: 'op', value: op, start: i, end: i + op.length });
  return i + op.length;
}

/** A reference (with or without a sheet prefix), name or function name at `i`; null if none starts there. */
function lexWord(src: string, i: number, tokens: Token[]): number | null {
  const rest = src.slice(i);
  // Sheet-prefixed reference: Sheet1!A1
  const sheetM = SHEET_IDENT.exec(rest);
  if (sheetM && src[i + sheetM[0].length] === '!') {
    const ref = lexRefBody(src, i + sheetM[0].length + 1, sheetM[0]);
    if (!ref) throw new FormulaSyntaxError('Expected a reference after sheet name', i);
    return pushRef(tokens, ref, i);
  }

  const ref = lexRefBody(src, i, null);
  if (ref) return pushRef(tokens, ref, i);

  const id = IDENT.exec(rest);
  if (!id) return null;
  const end = i + id[0].length;
  let j = end;
  while (j < src.length && src[j] === ' ') j++;
  if (src[j] === '(') {
    tokens.push({ type: 'func', value: id[0].toUpperCase(), start: i, end });
  } else {
    tokens.push({ type: 'name', value: id[0], start: i, end });
  }
  return end;
}

function pushRef(tokens: Token[], lexed: LexedRef, start: number): number {
  tokens.push({ type: 'ref', ref: lexed.ref, start, end: lexed.end });
  return lexed.end;
}

/** Lexes "A1", "$A$1:B2", "A:C" or "3:7" starting at `i`. */
function lexRefBody(src: string, i: number, sheet: string | null): LexedRef | null {
  const rest = src.slice(i);
  return lexCellRef(src, i, rest, sheet) ?? lexColRange(src, i, rest, sheet) ?? lexRowRange(src, i, sheet);
}

interface CellPart {
  r: number;
  c: number;
  absR: boolean;
  absC: boolean;
  end: number;
}

/**
 * A cell address that `m` matched at `i`, if it is a valid cell and does not
 * run on: "LOG10(" is a function, "A1B" is a name.
 */
function cellPart(src: string, i: number, m: RegExpExecArray | null): CellPart | null {
  if (!m) return null;
  const end = i + m[0].length;
  if (REF_RUNS_ON.test(src[end] ?? '')) return null;
  const c = lettersToCol(m[2]!);
  const r = Number(m[4]) - 1;
  if (c < 0 || r < 0 || r >= MAX_ROWS) return null;
  return { r, c, absR: m[3] === '$', absC: m[1] === '$', end };
}

/** "A1" or "A1:B2" at `i`; `rest` is `src` from `i` on. */
function lexCellRef(src: string, i: number, rest: string, sheet: string | null): LexedRef | null {
  const a = cellPart(src, i, CELL_PART.exec(rest));
  if (!a) return null;
  const b = src[a.end] === ':' ? cellPart(src, a.end + 1, CELL_PART.exec(src.slice(a.end + 1))) : null;
  if (b) {
    return {
      ref: orderRef({
        sheet,
        kind: 'range',
        r1: a.r,
        c1: a.c,
        r2: b.r,
        c2: b.c,
        absR1: a.absR,
        absC1: a.absC,
        absR2: b.absR,
        absC2: b.absC,
      }),
      end: b.end,
    };
  }
  return {
    ref: {
      sheet,
      kind: 'cell',
      r1: a.r,
      c1: a.c,
      r2: a.r,
      c2: a.c,
      absR1: a.absR,
      absC1: a.absC,
      absR2: a.absR,
      absC2: a.absC,
    },
    end: a.end,
  };
}

/** Column range "A:C" at `i`; `rest` is `src` from `i` on. */
function lexColRange(src: string, i: number, rest: string, sheet: string | null): LexedRef | null {
  const col1 = /^(\$?)([A-Za-z]{1,3})(?=:)/.exec(rest);
  if (!col1) return null;
  const after = i + col1[0].length + 1;
  const col2 = COL_PART.exec(src.slice(after));
  if (!col2) return null;
  const c1 = lettersToCol(col1[2]!);
  const c2 = lettersToCol(col2[2]!);
  if (c1 < 0 || c2 < 0) return null;
  return {
    ref: orderRef({
      sheet,
      kind: 'cols',
      r1: 0,
      c1,
      r2: MAX_ROWS - 1,
      c2,
      absR1: true,
      absC1: col1[1] === '$',
      absR2: true,
      absC2: col2[1] === '$',
    }),
    end: after + col2[0].length,
  };
}

function lexRowRange(
  src: string,
  i: number,
  sheet: string | null,
): { ref: RefToken; end: number } | null {
  const row1 = ROW_PART.exec(src.slice(i));
  if (!row1 || src[i + row1[0].length] !== ':') return null;
  const after = i + row1[0].length + 1;
  const row2 = ROW_PART.exec(src.slice(after));
  if (!row2) return null;
  const end = after + row2[0].length;
  if (/[A-Za-z0-9_(.]/.test(src[end] ?? '')) return null;
  const r1 = Number(row1[2]) - 1;
  const r2 = Number(row2[2]) - 1;
  if (r1 < 0 || r2 < 0 || r1 >= MAX_ROWS || r2 >= MAX_ROWS) return null;
  return {
    ref: orderRef({
      sheet,
      kind: 'rows',
      r1,
      c1: 0,
      r2,
      c2: MAX_COLS - 1,
      absR1: row1[1] === '$',
      absC1: true,
      absR2: row2[1] === '$',
      absC2: true,
    }),
    end,
  };
}

function orderRef(ref: RefToken): RefToken {
  if (ref.r1 > ref.r2) {
    [ref.r1, ref.r2] = [ref.r2, ref.r1];
    [ref.absR1, ref.absR2] = [ref.absR2, ref.absR1];
  }
  if (ref.c1 > ref.c2) {
    [ref.c1, ref.c2] = [ref.c2, ref.c1];
    [ref.absC1, ref.absC2] = [ref.absC2, ref.absC1];
  }
  return ref;
}
