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

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i]!;
    const rest = src.slice(i);

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      let j = i + 1;
      while (j < n && /\s/.test(src[j]!)) j++;
      tokens.push({ type: 'ws', start: i, end: j });
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= n) throw new FormulaSyntaxError('Unterminated string', i);
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        value += src[j];
        j++;
      }
      tokens.push({ type: 'string', value, start: i, end: j });
      i = j;
      continue;
    }

    // Quoted sheet name: 'My sheet'!A1
    if (ch === "'") {
      let j = i + 1;
      let name = '';
      for (;;) {
        if (j >= n) throw new FormulaSyntaxError('Unterminated sheet name', i);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            name += "'";
            j += 2;
            continue;
          }
          j++;
          break;
        }
        name += src[j];
        j++;
      }
      if (src[j] !== '!') throw new FormulaSyntaxError("Expected '!' after sheet name", j);
      const ref = lexRefBody(src, j + 1, name);
      if (!ref) throw new FormulaSyntaxError('Expected a reference after sheet name', j + 1);
      tokens.push({ type: 'ref', ref: ref.ref, start: i, end: ref.end });
      i = ref.end;
      continue;
    }

    if (ch === '#') {
      const m = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!)/i.exec(rest);
      if (!m) throw new FormulaSyntaxError('Unknown error literal', i);
      const code = m[0].toUpperCase();
      if (!isErrorCode(code)) throw new FormulaSyntaxError('Unknown error literal', i);
      tokens.push({ type: 'error', value: code, start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '{' || ch === '}') {
      tokens.push({ type: 'brace', value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ';') {
      tokens.push({ type: 'semicolon', start: i, end: i + 1 });
      i++;
      continue;
    }

    // Row range "3:7" / "$3:$7" must be tried before plain numbers.
    if (ch === '$' || (ch >= '0' && ch <= '9')) {
      const rows = lexRowRange(src, i, null);
      if (rows) {
        tokens.push({ type: 'ref', ref: rows.ref, start: i, end: rows.end });
        i = rows.end;
        continue;
      }
    }

    if ((ch >= '0' && ch <= '9') || (ch === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = NUMBER.exec(rest)!;
      tokens.push({ type: 'number', value: Number(m[0]), start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }

    if (ch === '$' || /[A-Za-z_\\À-￿]/.test(ch)) {
      // Sheet-prefixed reference: Sheet1!A1
      const sheetM = SHEET_IDENT.exec(rest);
      if (sheetM && src[i + sheetM[0].length] === '!') {
        const ref = lexRefBody(src, i + sheetM[0].length + 1, sheetM[0]);
        if (!ref) throw new FormulaSyntaxError('Expected a reference after sheet name', i);
        tokens.push({ type: 'ref', ref: ref.ref, start: i, end: ref.end });
        i = ref.end;
        continue;
      }

      const ref = lexRefBody(src, i, null);
      if (ref) {
        tokens.push({ type: 'ref', ref: ref.ref, start: i, end: ref.end });
        i = ref.end;
        continue;
      }

      const id = IDENT.exec(rest);
      if (id) {
        const end = i + id[0].length;
        let j = end;
        while (j < n && src[j] === ' ') j++;
        if (src[j] === '(') {
          tokens.push({ type: 'func', value: id[0].toUpperCase(), start: i, end });
        } else {
          tokens.push({ type: 'name', value: id[0], start: i, end });
        }
        i = end;
        continue;
      }
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ type: 'op', value: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }

    throw new FormulaSyntaxError(`Unexpected character '${ch}'`, i);
  }

  return tokens;
}

/** Lexes "A1", "$A$1:B2", "A:C" or "3:7" starting at `i`. */
function lexRefBody(
  src: string,
  i: number,
  sheet: string | null,
): { ref: RefToken; end: number } | null {
  const rest = src.slice(i);

  const cell = CELL_PART.exec(rest);
  if (cell) {
    const end1 = i + cell[0].length;
    // "LOG10(" is a function, "A1B" is a name: a cell ref may not run on.
    if (!/[A-Za-z0-9_(.]/.test(src[end1] ?? '') && src[end1] !== '!') {
      const c1 = lettersToCol(cell[2]!);
      const r1 = Number(cell[4]) - 1;
      if (c1 >= 0 && r1 >= 0 && r1 < MAX_ROWS) {
        const a = { r: r1, c: c1, absR: cell[3] === '$', absC: cell[1] === '$' };
        if (src[end1] === ':') {
          const cell2 = CELL_PART.exec(src.slice(end1 + 1));
          if (cell2) {
            const end2 = end1 + 1 + cell2[0].length;
            const c2 = lettersToCol(cell2[2]!);
            const r2 = Number(cell2[4]) - 1;
            if (!/[A-Za-z0-9_(.!]/.test(src[end2] ?? '') && c2 >= 0 && r2 >= 0 && r2 < MAX_ROWS) {
              return {
                ref: orderRef({
                  sheet,
                  kind: 'range',
                  r1: a.r,
                  c1: a.c,
                  r2,
                  c2,
                  absR1: a.absR,
                  absC1: a.absC,
                  absR2: cell2[3] === '$',
                  absC2: cell2[1] === '$',
                }),
                end: end2,
              };
            }
          }
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
          end: end1,
        };
      }
    }
  }

  // Column range "A:C"
  const col1 = /^(\$?)([A-Za-z]{1,3})(?=:)/.exec(rest);
  if (col1) {
    const after = i + col1[0].length + 1;
    const col2 = COL_PART.exec(src.slice(after));
    if (col2) {
      const c1 = lettersToCol(col1[2]!);
      const c2 = lettersToCol(col2[2]!);
      if (c1 >= 0 && c2 >= 0) {
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
    }
  }

  return lexRowRange(src, i, sheet);
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
