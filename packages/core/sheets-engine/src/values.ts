/**
 * Cell and formula values.
 *
 * Everything here is plain data so values can travel in ops, snapshots and
 * postMessage without a serialiser. `null` is the empty cell.
 */

export type ErrorCode =
  | '#NULL!'
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#NUM!'
  | '#N/A'
  | '#SPILL!'
  | '#CALC!';

export const ERROR_CODES: readonly ErrorCode[] = [
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#SPILL!',
  '#CALC!',
];

export interface CellError {
  kind: 'error';
  code: ErrorCode;
  /** Shown in the cell's hover card; never part of the value's identity. */
  message?: string;
}

/** A value a cell can hold or display. */
export type Scalar = number | string | boolean | CellError | null;

/** A rectangular reference produced while evaluating a formula. */
export interface RangeRef {
  kind: 'range';
  sheetId: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** An in-memory array (array constants, function results, lifted operators). */
export interface Matrix {
  kind: 'matrix';
  rows: number;
  cols: number;
  /** Row-major, `rows` arrays of `cols` values. */
  data: Scalar[][];
}

/** Anything a formula sub-expression can evaluate to. */
export type EvalValue = Scalar | RangeRef | Matrix;

export function err(code: ErrorCode, message?: string): CellError {
  return message ? { kind: 'error', code, message } : { kind: 'error', code };
}

export const ERR = {
  null: err('#NULL!'),
  div0: err('#DIV/0!'),
  value: err('#VALUE!'),
  ref: err('#REF!'),
  name: err('#NAME?'),
  num: err('#NUM!'),
  na: err('#N/A'),
  spill: err('#SPILL!'),
  calc: err('#CALC!'),
} as const;

export function isError(v: unknown): v is CellError {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'error';
}

export function isRange(v: unknown): v is RangeRef {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'range';
}

export function isMatrix(v: unknown): v is Matrix {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'matrix';
}

export function isErrorCode(s: string): s is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(s);
}

export function matrix(data: Scalar[][]): Matrix {
  return { kind: 'matrix', rows: data.length, cols: data[0]?.length ?? 0, data };
}

export function sameScalar(a: Scalar, b: Scalar): boolean {
  if (a === b) return true;
  if (isError(a) && isError(b)) return a.code === b.code;
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}

// ---------------------------------------------------------------------------
// Coercion, Excel rules
// ---------------------------------------------------------------------------

const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parses text the way arithmetic on a string does in Excel ("12" + 1 = 13).
 * Percentages and thousands separators are accepted; dates are handled by
 * `parseInput`, not here.
 */
export function parseNumericText(text: string): number | null {
  let s = text.trim();
  if (s === '') return null;
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/,(?=\d{3}(\D|$))/g, '');
  if (!NUMERIC_TEXT.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}

/** Coerces a scalar to a number, or returns the error that blocks it. */
export function toNumber(v: Scalar): number | CellError {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = parseNumericText(v);
    return n === null ? ERR.value : n;
  }
  return v;
}

export function toText(v: Scalar): string | CellError {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberToText(v);
  return v;
}

export function toBoolean(v: Scalar): boolean | CellError {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const u = v.trim().toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    return ERR.value;
  }
  return v;
}

/**
 * Number → text with the "General" format: up to 11 significant digits for
 * large and small magnitudes, plain decimals otherwise, no trailing zeros.
 */
export function formatGeneralNumber(n: number): string {
  if (!Number.isFinite(n)) return ERR.num.code;
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e11 || abs < 1e-9) {
    const [mant = '0', exp = '0'] = n.toExponential(5).split('e');
    const m = mant.includes('.') ? trimFraction(mant) : mant;
    const e = Number(exp);
    return `${m}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  const s = Number(n.toPrecision(15)).toString();
  if (!s.includes('e')) return s;
  return trimFraction(n.toFixed(20));
}

/**
 * Number → text as formulas see it (=A1&"", LEN, TEXTJOIN, text comparison):
 * up to 15 significant digits, E notation from 1E+15 up and below 1E-9, as in
 * Excel. Unlike the General display format this never drops to 6 digits, so
 * IDs and phone numbers survive concatenation.
 */
export function numberToText(n: number): string {
  if (!Number.isFinite(n)) return ERR.num.code;
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) {
    const [mant = '0', exp = '0'] = n.toExponential(14).split('e');
    const m = mant.includes('.') ? trimFraction(mant) : mant;
    const e = Number(exp);
    return `${m}E${e < 0 ? '-' : '+'}${Math.abs(e)}`;
  }
  const rounded = Number(n.toPrecision(15));
  const s = rounded.toString();
  if (!s.includes('e')) return s;
  // Between 1E-9 and 1E-7 toString switches to exponent form: write the decimals out.
  return trimFraction(rounded.toFixed(Math.min(100, 15 - Math.floor(Math.log10(abs)))));
}

/** Drops trailing zeros, then a trailing decimal point: "1.500" → "1.5", "2.000" → "2". */
function trimFraction(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '0') end--;
  if (end > 0 && s[end - 1] === '.') end--;
  return s.slice(0, end);
}

/**
 * Ordering used by comparisons and sorting: numbers < text < booleans, errors
 * excluded (callers propagate them first). Text compares case-insensitively.
 * Blank compares as 0, "" or FALSE depending on the other side, as in Excel.
 */
export function compareScalars(a: Scalar, b: Scalar): number {
  const ra = a === null ? blankLike(b) : a;
  const rb = b === null ? blankLike(a) : b;
  const ta = typeRank(ra);
  const tb = typeRank(rb);
  if (ta !== tb) return ta - tb;
  if (typeof ra === 'number' && typeof rb === 'number') return ra - rb;
  if (typeof ra === 'string' && typeof rb === 'string') {
    const la = ra.toLowerCase();
    const lb = rb.toLowerCase();
    if (la < lb) return -1;
    return la > lb ? 1 : 0;
  }
  if (typeof ra === 'boolean' && typeof rb === 'boolean') return Number(ra) - Number(rb);
  return 0;
}

function blankLike(other: Scalar): Scalar {
  if (typeof other === 'string') return '';
  if (typeof other === 'boolean') return false;
  return 0;
}

function typeRank(v: Scalar): number {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}
