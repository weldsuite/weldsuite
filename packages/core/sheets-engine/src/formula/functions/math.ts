/**
 * Math and trigonometry: sums and products (with the *IF/*IFS criteria
 * forms), rounding, number theory, combinatorics, trig, matrices, SUBTOTAL /
 * AGGREGATE and the numeral-system conversions.
 */

import { ERR, isError, isMatrix, isRange, matrix, type CellError, type EvalValue, type Scalar } from '../../values';
import { MAX_MATRIX_CELLS } from '../evaluator';
import type { EvalContext, EvalHost, FunctionSpec } from '../types';
import { collectNumbers, int, num, text, toMatrix } from './helpers';
import { getFunction } from './registry';
import {
  alignArgs,
  combin,
  criteriaPairs,
  factorial,
  matchedNumbers,
  numericFn,
  numResult,
  pairedNumbers,
  readNums,
  scanIf,
  scanIfs,
  sumOf,
} from './stats';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rounds to 15 significant digits, the precision Excel works in, so binary
 * noise (2.675 * 100 = 267.49999999999997) does not flip a rounding step.
 */
function clean(x: number): number {
  return x === 0 || !Number.isFinite(x) ? x : Number(x.toPrecision(15));
}

type RoundMode = 'half' | 'up' | 'down';

/** ROUND / ROUNDUP / ROUNDDOWN: half away from zero, away from zero, toward zero. */
function roundTo(x: number, digits: number, mode: RoundMode): number {
  const d = Math.trunc(digits);
  const scale = Math.pow(10, Math.abs(d));
  if (!Number.isFinite(scale)) return d > 0 ? x : 0;
  const ax = Math.abs(x);
  const scaled = clean(d >= 0 ? ax * scale : ax / scale);
  if (scaled >= 2 ** 53) return x;
  const r = roundMagnitude(scaled, mode);
  const out = d >= 0 ? r / scale : r * scale;
  return x < 0 ? -out : out;
}

/** Rounds a non-negative scaled value to a whole number in the given mode. */
function roundMagnitude(scaled: number, mode: RoundMode): number {
  if (mode === 'half') return Math.floor(scaled + 0.5);
  if (mode === 'up') return Math.ceil(scaled);
  return Math.floor(scaled);
}

/** n rounded to a multiple of `sig`, `step` deciding the direction of n / sig. */
function toMultiple(n: number, sig: number, step: (q: number) => number): number {
  return clean(step(clean(n / sig)) * sig);
}

const halfUp = (q: number): number => Math.floor(q + 0.5);

/** Integer arguments of the combinatorics functions, truncated; negatives are #NUM!. */
function naturals(x: number[]): number[] | CellError {
  const out = x.map(Math.trunc);
  return out.some((n) => n < 0) ? ERR.num : out;
}

function gcd2(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Whole numbers 0 ≤ n < 2^53 for GCD/LCM, truncated. */
function gcdArgs(args: EvalValue[], ctx: EvalContext): number[] | CellError {
  const xs = collectNumbers(args, ctx);
  if (isError(xs)) return xs;
  const out: number[] = [];
  for (const x of xs) {
    if (x < 0 || x >= 2 ** 53) return ERR.num;
    out.push(Math.trunc(x));
  }
  return out;
}

/** A range or array of numbers only (matrix functions); anything else is #VALUE!. */
function numberMatrix(v: EvalValue, ctx: EvalContext): number[][] | CellError {
  const m = toMatrix(v, ctx);
  if (isError(m)) return m;
  const out: number[][] = [];
  for (const row of m.data) {
    const r: number[] = [];
    for (const x of row) {
      if (isError(x)) return x;
      if (typeof x !== 'number') return ERR.value;
      r.push(x);
    }
    out.push(r);
  }
  return out;
}

/** Partial pivoting: the row at or below `col` with the largest magnitude in column `col`. */
function pivotRow(m: number[][], col: number): number {
  let pivot = col;
  for (let r = col + 1; r < m.length; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
  return pivot;
}

/** Gaussian elimination step: zeroes column `col` below the pivot row `col` (pivot value `p`). */
function eliminateBelow(m: number[][], col: number, p: number): void {
  const n = m.length;
  for (let r = col + 1; r < n; r++) {
    const f = m[r]![col]! / p;
    if (f === 0) continue;
    for (let c = col; c < n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
  }
}

/** Gauss-Jordan step: zeroes column `col` in every row but the (normalised) pivot row `col`. */
function eliminateOthers(m: number[][], col: number): void {
  const row = m[col]!;
  for (let r = 0; r < m.length; r++) {
    if (r === col) continue;
    const f = m[r]![col]!;
    if (f === 0) continue;
    for (let c = 0; c < row.length; c++) m[r]![c] = m[r]![c]! - f * row[c]!;
  }
}

function determinant(a: number[][]): number {
  const n = a.length;
  const m = a.map((row) => row.slice());
  let det = 1;
  for (let col = 0; col < n; col++) {
    const pivot = pivotRow(m, col);
    if (m[pivot]![col] === 0) return 0;
    if (pivot !== col) {
      [m[pivot], m[col]] = [m[col]!, m[pivot]!];
      det = -det;
    }
    const p = m[col]![col]!;
    det *= p;
    eliminateBelow(m, col, p);
  }
  return det;
}

function inverse(a: number[][]): number[][] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  let scale = 0;
  for (const row of a) for (const x of row) scale = Math.max(scale, Math.abs(x));
  for (let col = 0; col < n; col++) {
    const pivot = pivotRow(m, col);
    const p = m[pivot]![col]!;
    if (Math.abs(p) <= 1e-15 * scale) return null;
    [m[pivot], m[col]] = [m[col]!, m[pivot]!];
    const row = m[col]!;
    for (let c = 0; c < 2 * n; c++) row[c] = row[c]! / p;
    eliminateOthers(m, col);
  }
  return m.map((row) => row.slice(n));
}

const ROMAN_CHARS = ['M', 'D', 'C', 'L', 'X', 'V', 'I'];
const ROMAN_VALUES = [1000, 500, 100, 50, 10, 5, 1];

/**
 * The numeral subtracted in a 4/9 pair: starting at ladder index `idx`, it
 * steps down up to `form` times while the pair (ROMAN_VALUES[idx2] minus the
 * smaller numeral) still fits in `n`.
 */
function romanSubtrahend(n: number, idx: number, idx2: number, form: number): number {
  const last = ROMAN_VALUES.length - 1;
  let lo = idx;
  for (let steps = 0; steps < form && lo < last; steps++) {
    if (ROMAN_VALUES[idx2]! - ROMAN_VALUES[lo + 1]! > n) break;
    lo++;
  }
  return lo;
}

/**
 * Excel's ROMAN, forms 0 (classic) to 4 (most concise). Each subtractive
 * pair may reach further down the numeral ladder as the form grows, e.g.
 * 499 → CDXCIX, LDVLIV, XDIX, VDIV, ID.
 */
function toRoman(value: number, form: number): string {
  let n = value;
  let out = '';
  const last = ROMAN_VALUES.length - 1;
  for (let i = 0; i <= last / 2; i++) {
    let idx = 2 * i;
    const digit = Math.floor(n / ROMAN_VALUES[idx]!);
    if (digit % 5 === 4) {
      const idx2 = digit === 4 ? idx - 1 : idx - 2;
      idx = romanSubtrahend(n, idx, idx2, form);
      out += ROMAN_CHARS[idx]! + ROMAN_CHARS[idx2]!;
      n = n + ROMAN_VALUES[idx]! - ROMAN_VALUES[idx2]!;
    } else {
      if (digit > 4) out += ROMAN_CHARS[idx - 1]!;
      out += ROMAN_CHARS[idx]!.repeat(digit % 5);
      n %= ROMAN_VALUES[idx]!;
    }
  }
  return out;
}

/** ROMAN's form argument: omitted or TRUE is 0 (classic), FALSE is 4 (most concise), else a number. */
function romanForm(f: EvalValue | undefined, ctx: EvalContext): number | CellError {
  if (f === undefined || f === null) return 0;
  if (typeof f === 'boolean') return f ? 0 : 4;
  return int(f, ctx);
}

const ROMAN_DIGIT: Record<string, number> ={ I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function fromRoman(s: string): number | null {
  let total = 0;
  let max = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = ROMAN_DIGIT[s[i]!];
    if (v === undefined) return null;
    if (v < max) total -= v;
    else {
      total += v;
      max = v;
    }
  }
  return total;
}

/** SUBTOTAL function numbers 1–11 (101–111 add "ignore hidden rows"). */
const SUBTOTAL_FNS = ['AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV', 'STDEVP', 'SUM', 'VAR', 'VARP'];

/** AGGREGATE function numbers 1–19; 14 and up take (array, k). */
const AGGREGATE_FNS = [
  'AVERAGE',
  'COUNT',
  'COUNTA',
  'MAX',
  'MIN',
  'PRODUCT',
  'STDEV.S',
  'STDEV.P',
  'SUM',
  'VAR.S',
  'VAR.P',
  'MEDIAN',
  'MODE.SNGL',
  'LARGE',
  'SMALL',
  'PERCENTILE.INC',
  'QUARTILE.INC',
  'PERCENTILE.EXC',
  'QUARTILE.EXC',
];

/** What SUBTOTAL and AGGREGATE leave out of their ranges. */
interface Skip {
  /** Rows hidden by the filter, by the filter or by hand, or none. */
  hidden: 'none' | 'filtered' | 'all';
  /** Cells that hold a SUBTOTAL or AGGREGATE themselves. */
  nested: boolean;
}

const NESTED = /^\s*(?:SUBTOTAL|AGGREGATE)\s*\(/i;

/** A context whose ranges leave out what `skip` says (blank, as far as the aggregate can tell). */
function skipping(ctx: EvalContext, skip: Skip): EvalContext {
  if (skip.hidden === 'none' && !skip.nested) return ctx;
  const host = ctx.host;
  const skipped = (sheetId: string, row: number, col: number): boolean =>
    (skip.hidden !== 'none' && host.isRowHidden(sheetId, row, skip.hidden === 'all')) ||
    (skip.nested && NESTED.test(host.cellFormula(sheetId, row, col) ?? ''));
  const visible: EvalHost = {
    cellValue: (s, r, c) => (skipped(s, r, c) ? null : host.cellValue(s, r, c)),
    forEachValue: (s, range, fn) => host.forEachValue(s, range, (r, c, v) => !skipped(s, r, c) && fn(r, c, v)),
    usedRange: (s) => host.usedRange(s),
    sheetIdByName: (name) => host.sheetIdByName(name),
    sheetName: (s) => host.sheetName(s),
    sheetIds: () => host.sheetIds(),
    definedName: (name, s) => host.definedName(name, s),
    now: () => host.now(),
    random: () => host.random(),
    timezoneOffset: () => host.timezoneOffset(),
    isRowHidden: (s, r, manual) => host.isRowHidden(s, r, manual),
    cellFormula: (s, r, c) => host.cellFormula(s, r, c),
  };
  return { ...ctx, host: visible };
}

function callByName(name: string, args: EvalValue[], ctx: EvalContext): EvalValue {
  const spec = getFunction(name);
  if (!spec || spec.lazy) return ERR.value;
  return spec.impl(args, ctx);
}

/** An argument with its error values blanked out (AGGREGATE options 2, 3, 6, 7); a direct error is dropped. */
function withoutErrors(v: EvalValue, ctx: EvalContext): EvalValue | undefined {
  if (isRange(v) || isMatrix(v)) {
    const m = toMatrix(v, ctx);
    if (isError(m)) return undefined;
    return matrix(m.data.map((row) => row.map((x) => (isError(x) ? null : x))));
  }
  return isError(v) ? undefined : v;
}

function sumWith(name: string, fn: (x: number, y: number) => number): FunctionSpec {
  return {
    name,
    minArgs: 2,
    maxArgs: 2,
    impl(args, ctx) {
      const p = pairedNumbers(args[0]!, args[1]!, ctx);
      if (isError(p)) return p;
      let s = 0;
      for (let i = 0; i < p.xs.length; i++) s += fn(p.xs[i]!, p.ys[i]!);
      return numResult(s);
    },
  };
}

function trig(name: string, fn: (x: number) => number | CellError, limit = false): FunctionSpec {
  return numericFn(name, 1, 1, ([x]) => (limit && Math.abs(x!) >= 2 ** 27 ? ERR.num : fn(x!)));
}

function ceilingMath(name: string, precise: boolean): FunctionSpec {
  return numericFn(
    name,
    1,
    precise ? 2 : 3,
    ([n, s, mode]) => {
      const sig = Math.abs(s!);
      if (sig === 0 || n === 0) return 0;
      if (n! < 0 && (mode ?? 0) !== 0) return -toMultiple(-n!, sig, Math.ceil);
      return toMultiple(n!, sig, Math.ceil);
    },
    [undefined, 1, 0],
  );
}

function floorMath(name: string, precise: boolean): FunctionSpec {
  return numericFn(
    name,
    1,
    precise ? 2 : 3,
    ([n, s, mode]) => {
      const sig = Math.abs(s!);
      if (sig === 0 || n === 0) return 0;
      if (n! < 0 && (mode ?? 0) !== 0) return -toMultiple(-n!, sig, Math.floor);
      return toMultiple(n!, sig, Math.floor);
    },
    [undefined, 1, 0],
  );
}

const SUMIFS_CRITERIA = Array.from({ length: 127 }, (_, i) => 2 + 2 * i);

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export const mathFunctions: FunctionSpec[] = [
  // --- sums and products ---------------------------------------------------
  {
    name: 'SUM',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = collectNumbers(args, ctx);
      return isError(xs) ? xs : numResult(sumOf(xs));
    },
  },
  {
    name: 'SUMSQ',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = collectNumbers(args, ctx);
      return isError(xs) ? xs : numResult(sumOf(xs.map((x) => x * x)));
    },
  },
  {
    /** PRODUCT of no numbers is 0, as in Excel. */
    name: 'PRODUCT',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = collectNumbers(args, ctx);
      if (isError(xs)) return xs;
      return xs.length ? numResult(xs.reduce((a, b) => a * b, 1)) : 0;
    },
  },
  {
    /** Same-shaped arrays multiplied cell by cell; text, booleans and blanks count as 0. */
    name: 'SUMPRODUCT',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const al = alignArgs(args, ctx);
      if (isError(al)) return al;
      let s = 0;
      for (let r = 0; r < al.rows; r++) {
        for (let c = 0; c < al.cols; c++) {
          let p = 1;
          for (const m of al.mats) {
            const v = m.data[r]![c]!;
            if (isError(v)) return v;
            p *= typeof v === 'number' ? v : 0;
          }
          s += p;
        }
      }
      return numResult(s);
    },
  },
  {
    name: 'SUMIF',
    minArgs: 2,
    maxArgs: 3,
    scalarArgs: [1],
    impl(args, ctx) {
      const scan = scanIf(args, ctx);
      if (isError(scan)) return scan;
      const xs = matchedNumbers(scan.values);
      return isError(xs) ? xs : numResult(sumOf(xs));
    },
  },
  {
    name: 'SUMIFS',
    minArgs: 3,
    maxArgs: 255,
    scalarArgs: SUMIFS_CRITERIA,
    impl(args, ctx) {
      const pairs = criteriaPairs(args, 1, ctx);
      if (isError(pairs)) return pairs;
      const scan = scanIfs(args[0]!, pairs, ctx);
      if (isError(scan)) return scan;
      const xs = matchedNumbers(scan.values);
      return isError(xs) ? xs : numResult(sumOf(xs));
    },
  },
  sumWith('SUMX2MY2', (x, y) => x * x - y * y),
  sumWith('SUMX2PY2', (x, y) => x * x + y * y),
  sumWith('SUMXMY2', (x, y) => (x - y) * (x - y)),
  {
    name: 'SERIESSUM',
    minArgs: 4,
    maxArgs: 4,
    impl(args, ctx) {
      const p = readNums(args, ctx, 3);
      if (isError(p)) return p;
      const coef = numberMatrix(args[3]!, ctx);
      if (isError(coef)) return coef;
      const [x, n, m] = p as [number, number, number];
      let s = 0;
      let i = 0;
      for (const row of coef) for (const a of row) s += a * Math.pow(x, n + i++ * m);
      return numResult(s);
    },
  },

  // --- sign, rounding ------------------------------------------------------
  numericFn('ABS', 1, 1, ([x]) => Math.abs(x!)),
  numericFn('SIGN', 1, 1, ([x]) => Math.sign(x!)),
  numericFn('INT', 1, 1, ([x]) => Math.floor(clean(x!))),
  numericFn('TRUNC', 1, 2, ([x, d]) => roundTo(x!, d!, 'down'), [undefined, 0]),
  numericFn('ROUND', 2, 2, ([x, d]) => roundTo(x!, d!, 'half')),
  numericFn('ROUNDUP', 2, 2, ([x, d]) => roundTo(x!, d!, 'up')),
  numericFn('ROUNDDOWN', 2, 2, ([x, d]) => roundTo(x!, d!, 'down')),
  numericFn('MROUND', 2, 2, ([n, m]) => {
    if (m === 0 || n === 0) return 0;
    if (Math.sign(n!) !== Math.sign(m!)) return ERR.num;
    return toMultiple(n!, m!, halfUp);
  }),
  numericFn('CEILING', 2, 2, ([n, sig]) => {
    if (sig === 0 || n === 0) return 0;
    if (n! > 0 && sig! < 0) return ERR.num;
    return toMultiple(n!, sig!, Math.ceil);
  }),
  ceilingMath('CEILING.MATH', false),
  ceilingMath('CEILING.PRECISE', true),
  numericFn('FLOOR', 2, 2, ([n, sig]) => {
    if (n === 0) return 0;
    if (sig === 0) return ERR.div0;
    if (n! > 0 && sig! < 0) return ERR.num;
    return toMultiple(n!, sig!, Math.floor);
  }),
  floorMath('FLOOR.MATH', false),
  floorMath('FLOOR.PRECISE', true),
  numericFn('EVEN', 1, 1, ([x]) => {
    const v = Math.ceil(clean(Math.abs(x!)) / 2) * 2;
    return x! < 0 ? -v : v;
  }),
  numericFn('ODD', 1, 1, ([x]) => {
    let v = Math.ceil(clean(Math.abs(x!)));
    if (v % 2 === 0) v++;
    return x! < 0 ? -v : v;
  }),

  // --- arithmetic ----------------------------------------------------------
  numericFn('MOD', 2, 2, ([n, d]) => {
    if (d === 0) return ERR.div0;
    const r = n! - d! * Math.floor(clean(n! / d!));
    return Math.abs(r) < Math.abs(d!) * 1e-14 ? 0 : r;
  }),
  numericFn('QUOTIENT', 2, 2, ([n, d]) => (d === 0 ? ERR.div0 : Math.trunc(clean(n! / d!)))),
  numericFn('POWER', 2, 2, ([b, e]) => {
    if (b === 0 && e === 0) return ERR.num;
    if (b === 0 && e! < 0) return ERR.div0;
    return Math.pow(b!, e!);
  }),
  numericFn('SQRT', 1, 1, ([x]) => (x! < 0 ? ERR.num : Math.sqrt(x!))),
  numericFn('SQRTPI', 1, 1, ([x]) => (x! < 0 ? ERR.num : Math.sqrt(x! * Math.PI))),
  numericFn('EXP', 1, 1, ([x]) => Math.exp(x!)),
  numericFn('LN', 1, 1, ([x]) => (x! <= 0 ? ERR.num : Math.log(x!))),
  numericFn('LOG10', 1, 1, ([x]) => (x! <= 0 ? ERR.num : Math.log10(x!))),
  numericFn(
    'LOG',
    1,
    2,
    ([x, base]) => {
      if (x! <= 0 || base! <= 0) return ERR.num;
      if (base === 1) return ERR.div0;
      if (base === 10) return Math.log10(x!);
      if (base === 2) return Math.log2(x!);
      const r = Math.log(x!) / Math.log(base!);
      // LOG(125, 5) is 3, not 3.0000000000000004.
      const k = Math.round(r);
      return Math.abs(r - k) < 1e-14 * Math.max(1, Math.abs(r)) ? k : r;
    },
    [undefined, 10],
  ),
  { name: 'PI', minArgs: 0, maxArgs: 0, impl: () => Math.PI },

  // --- random --------------------------------------------------------------
  { name: 'RAND', minArgs: 0, maxArgs: 0, volatile: true, impl: (_args, ctx) => ctx.host.random() },
  {
    name: 'RANDBETWEEN',
    minArgs: 2,
    maxArgs: 2,
    volatile: true,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, 2);
      if (isError(x)) return x;
      const lo = Math.ceil(x[0]!);
      const hi = Math.floor(x[1]!);
      if (lo > hi) return ERR.num;
      return lo + Math.floor(ctx.host.random() * (hi - lo + 1));
    },
  },
  {
    name: 'RANDARRAY',
    minArgs: 0,
    maxArgs: 5,
    volatile: true,
    impl(args, ctx) {
      const x = readNums(args, ctx, 4, [1, 1, 0, 1]);
      if (isError(x)) return x;
      const whole = args[4] === undefined || args[4] === null ? false : num(args[4], ctx);
      if (isError(whole)) return whole;
      const rows = Math.trunc(x[0]!);
      const cols = Math.trunc(x[1]!);
      const lo = x[2]!;
      const hi = x[3]!;
      if (rows < 0 || cols < 0 || lo > hi) return ERR.value;
      if (rows === 0 || cols === 0) return ERR.calc;
      if (rows * cols > MAX_MATRIX_CELLS) return { ...ERR.calc, message: 'Array too large' };
      const integer = whole !== false && whole !== 0;
      if (integer && (!Number.isInteger(lo) || !Number.isInteger(hi))) return ERR.value;
      const data: Scalar[][] = [];
      for (let r = 0; r < rows; r++) {
        const row: Scalar[] = [];
        for (let c = 0; c < cols; c++) {
          const u = ctx.host.random();
          row.push(integer ? lo + Math.floor(u * (hi - lo + 1)) : lo + u * (hi - lo));
        }
        data.push(row);
      }
      return matrix(data);
    },
  },

  // --- number theory and combinatorics ---------------------------------------
  {
    name: 'GCD',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = gcdArgs(args, ctx);
      return isError(xs) ? xs : xs.reduce(gcd2, 0);
    },
  },
  {
    name: 'LCM',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = gcdArgs(args, ctx);
      if (isError(xs)) return xs;
      let l = 1;
      for (const x of xs) {
        if (x === 0) return 0;
        l = (l / gcd2(l, x)) * x;
      }
      return numResult(l);
    },
  },
  numericFn('FACT', 1, 1, ([x]) => {
    const n = Math.trunc(x!);
    return n < 0 ? ERR.num : factorial(n);
  }),
  numericFn('FACTDOUBLE', 1, 1, ([x]) => {
    const n = Math.trunc(x!);
    if (n < -1) return ERR.num;
    let r = 1;
    for (let i = n; i > 1 && Number.isFinite(r); i -= 2) r *= i;
    return r;
  }),
  numericFn('COMBIN', 2, 2, (x) => {
    const v = naturals(x);
    if (isError(v)) return v;
    const [n, k] = v as [number, number];
    return n < k ? ERR.num : combin(n, k);
  }),
  numericFn('COMBINA', 2, 2, (x) => {
    const v = naturals(x);
    if (isError(v)) return v;
    const [n, k] = v as [number, number];
    if (n < k) return ERR.num;
    return k === 0 ? 1 : combin(n + k - 1, k);
  }),
  numericFn('PERMUT', 2, 2, (x) => {
    const v = naturals(x);
    if (isError(v)) return v;
    const [n, k] = v as [number, number];
    if (n < k) return ERR.num;
    let r = 1;
    for (let i = n - k + 1; i <= n; i++) {
      r *= i;
      if (!Number.isFinite(r)) return ERR.num;
    }
    return r;
  }),
  numericFn('PERMUTATIONA', 2, 2, (x) => {
    const v = naturals(x);
    if (isError(v)) return v;
    const [n, k] = v as [number, number];
    return Math.pow(n, k);
  }),
  {
    name: 'MULTINOMIAL',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = collectNumbers(args, ctx);
      if (isError(xs)) return xs;
      const ns = naturals(xs);
      if (isError(ns)) return ns;
      // (a+b+…)! / (a!·b!·…) as a product of binomials, which overflows later.
      let total = 0;
      let r = 1;
      for (const n of ns) {
        total += n;
        r *= combin(total, n);
      }
      return numResult(r);
    },
  },

  // --- trigonometry ----------------------------------------------------------
  numericFn('DEGREES', 1, 1, ([x]) => (x! * 180) / Math.PI),
  numericFn('RADIANS', 1, 1, ([x]) => (x! * Math.PI) / 180),
  trig('SIN', Math.sin),
  trig('COS', Math.cos),
  trig('TAN', Math.tan),
  trig('ASIN', (x) => (x < -1 || x > 1 ? ERR.num : Math.asin(x))),
  trig('ACOS', (x) => (x < -1 || x > 1 ? ERR.num : Math.acos(x))),
  trig('ATAN', Math.atan),
  numericFn('ATAN2', 2, 2, ([x, y]) => (x === 0 && y === 0 ? ERR.div0 : Math.atan2(y!, x!))),
  trig('SINH', Math.sinh),
  trig('COSH', Math.cosh),
  trig('TANH', Math.tanh),
  trig('ASINH', Math.asinh),
  trig('ACOSH', (x) => (x < 1 ? ERR.num : Math.acosh(x))),
  trig('ATANH', (x) => (x <= -1 || x >= 1 ? ERR.num : Math.atanh(x))),
  trig('COT', (x) => (x === 0 ? ERR.div0 : 1 / Math.tan(x)), true),
  trig('COTH', (x) => (x === 0 ? ERR.div0 : 1 / Math.tanh(x)), true),
  trig('CSC', (x) => (x === 0 ? ERR.div0 : 1 / Math.sin(x)), true),
  trig('CSCH', (x) => (x === 0 ? ERR.div0 : 1 / Math.sinh(x)), true),
  trig('SEC', (x) => 1 / Math.cos(x), true),
  trig('SECH', (x) => 1 / Math.cosh(x), true),
  trig('ACOT', (x) => Math.PI / 2 - Math.atan(x)),
  trig('ACOTH', (x) => (Math.abs(x) <= 1 ? ERR.num : 0.5 * Math.log((x + 1) / (x - 1)))),

  // --- SUBTOTAL / AGGREGATE ------------------------------------------------
  {
    /**
     * Skips rows the filter hides and cells holding SUBTOTAL or AGGREGATE;
     * function numbers 101–111 also skip rows hidden by hand.
     */
    name: 'SUBTOTAL',
    minArgs: 2,
    maxArgs: 255,
    readsRowVisibility: true,
    impl(args, ctx) {
      const code = int(args[0]!, ctx);
      if (isError(code)) return code;
      const name = SUBTOTAL_FNS[(code > 100 ? code - 100 : code) - 1];
      if (!name || code < 1) return ERR.value;
      return callByName(name, args.slice(1), skipping(ctx, { hidden: code > 100 ? 'all' : 'filtered', nested: true }));
    },
  },
  {
    /**
     * Options 0–3 skip cells holding SUBTOTAL or AGGREGATE; 1, 3, 5 and 7 skip
     * hidden rows (filtered or by hand); 2, 3, 6 and 7 ignore error values.
     */
    name: 'AGGREGATE',
    minArgs: 3,
    maxArgs: 255,
    readsRowVisibility: true,
    impl(args, ctx) {
      const code = int(args[0]!, ctx);
      if (isError(code)) return code;
      const option = args[1] === null ? 0 : int(args[1]!, ctx);
      if (isError(option)) return option;
      const name = AGGREGATE_FNS[code - 1];
      if (!name || code < 1 || option < 0 || option > 7) return ERR.value;
      let rest = args.slice(2);
      if (code >= 14 && rest.length !== 2) return ERR.value;
      const inner = skipping(ctx, { hidden: [1, 3, 5, 7].includes(option) ? 'all' : 'none', nested: option <= 3 });
      if ([2, 3, 6, 7].includes(option)) {
        const data = code >= 14 ? rest.slice(0, 1) : rest;
        const cleaned = data.map((a) => withoutErrors(a, inner)).filter((a): a is EvalValue => a !== undefined);
        rest = code >= 14 ? [cleaned[0] ?? null, rest[1]!] : cleaned;
        if (rest.length === 0) return ERR.value;
      }
      return callByName(name, rest, inner);
    },
  },

  // --- matrices ------------------------------------------------------------
  {
    name: 'MMULT',
    minArgs: 2,
    maxArgs: 2,
    impl(args, ctx) {
      const a = numberMatrix(args[0]!, ctx);
      if (isError(a)) return a;
      const b = numberMatrix(args[1]!, ctx);
      if (isError(b)) return b;
      const inner = a[0]?.length ?? 0;
      if (inner !== b.length) return ERR.value;
      const cols = b[0]?.length ?? 0;
      return matrix(
        a.map((row) =>
          Array.from({ length: cols }, (_, j) => {
            let s = 0;
            for (let k = 0; k < inner; k++) s += row[k]! * b[k]![j]!;
            return numResult(s);
          }),
        ),
      );
    },
  },
  {
    name: 'MDETERM',
    minArgs: 1,
    maxArgs: 1,
    impl(args, ctx) {
      const a = numberMatrix(args[0]!, ctx);
      if (isError(a)) return a;
      if (a.length !== (a[0]?.length ?? 0)) return ERR.value;
      return numResult(determinant(a));
    },
  },
  {
    name: 'MINVERSE',
    minArgs: 1,
    maxArgs: 1,
    impl(args, ctx) {
      const a = numberMatrix(args[0]!, ctx);
      if (isError(a)) return a;
      if (a.length !== (a[0]?.length ?? 0)) return ERR.value;
      const inv = inverse(a);
      if (!inv) return ERR.num;
      return matrix(inv.map((row) => row.map(numResult)));
    },
  },
  {
    name: 'MUNIT',
    minArgs: 1,
    maxArgs: 1,
    impl(args, ctx) {
      const n = int(args[0]!, ctx);
      if (isError(n)) return n;
      if (n < 1) return ERR.value;
      if (n * n > MAX_MATRIX_CELLS) return { ...ERR.calc, message: 'Array too large' };
      return matrix(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    },
  },

  // --- numeral systems -----------------------------------------------------
  {
    name: 'ROMAN',
    minArgs: 1,
    maxArgs: 2,
    scalarArgs: 'all',
    impl(args, ctx) {
      const n = num(args[0]!, ctx);
      if (isError(n)) return n;
      const form = romanForm(args[1], ctx);
      if (isError(form)) return form;
      const v = Math.trunc(n);
      if (v < 0 || v > 3999 || form < 0 || form > 4) return ERR.value;
      return toRoman(v, form);
    },
  },
  {
    name: 'ARABIC',
    minArgs: 1,
    maxArgs: 1,
    scalarArgs: 'all',
    impl(args, ctx) {
      const t = text(args[0]!, ctx);
      if (isError(t)) return t;
      if (t.length > 255) return ERR.value;
      let s = t.trim().toUpperCase();
      const negative = s.startsWith('-');
      if (negative) s = s.slice(1);
      const v = fromRoman(s);
      if (v === null) return ERR.value;
      return negative && v !== 0 ? -v : v;
    },
  },
  {
    name: 'BASE',
    minArgs: 2,
    maxArgs: 3,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, 3);
      if (isError(x)) return x;
      const n = Math.trunc(x[0]!);
      const radix = Math.trunc(x[1]!);
      const width = Math.trunc(x[2]!);
      if (n < 0 || n >= 2 ** 53 || radix < 2 || radix > 36 || width < 0 || width > 255) return ERR.num;
      return n.toString(radix).toUpperCase().padStart(width, '0');
    },
  },
  {
    name: 'DECIMAL',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: 'all',
    impl(args, ctx) {
      const t = text(args[0]!, ctx);
      if (isError(t)) return t;
      const radix = int(args[1]!, ctx);
      if (isError(radix)) return radix;
      if (radix < 2 || radix > 36) return ERR.num;
      if (t.length > 255) return ERR.value;
      let v = 0;
      for (const ch of t.toUpperCase()) {
        const d = parseInt(ch, 36);
        if (Number.isNaN(d) || d >= radix) return ERR.num;
        v = v * radix + d;
      }
      return numResult(v);
    },
  },
];
