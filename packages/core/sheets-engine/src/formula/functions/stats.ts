/**
 * Statistical functions: averages and counts, the *IF / *IFS family, order
 * statistics, dispersion, regression and the common distributions.
 *
 * Also home of the range alignment and criteria scanning that SUMIF(S) and
 * SUMPRODUCT in math.ts share with COUNTIFS and friends.
 */

import { MAX_COLS, MAX_ROWS } from '../../address';
import {
  ERR,
  isError,
  isMatrix,
  isRange,
  matrix,
  toNumber,
  type CellError,
  type EvalValue,
  type Matrix,
  type RangeRef,
  type Scalar,
} from '../../values';
import { clippedExtent } from '../evaluator';
import type { EvalContext, FunctionSpec } from '../types';
import {
  bool,
  collectNumbers,
  collectNumbersA,
  compileCriteria,
  dims,
  num,
  toMatrix,
  toScalar,
  visitArgs,
} from './helpers';

// ---------------------------------------------------------------------------
// Shared plumbing (also used by math.ts)
// ---------------------------------------------------------------------------

/** Number result: NaN and ±Infinity become #NUM!, -0 becomes 0. */
export function numResult(n: number): number | CellError {
  if (!Number.isFinite(n)) return ERR.num;
  return n === 0 ? 0 : n;
}

/**
 * Reads the first `count` arguments as numbers. An omitted or empty argument
 * takes `defaults[i]` when one is given, 0 otherwise. The first error wins.
 */
export function readNums(
  args: EvalValue[],
  ctx: EvalContext,
  count: number,
  defaults: ReadonlyArray<number | undefined> = [],
): number[] | CellError {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = args[i];
    if (a === undefined || a === null) {
      out.push(defaults[i] ?? 0);
      continue;
    }
    const n = num(a, ctx);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/**
 * A function of numeric arguments, applied element-wise over arrays
 * (=SQRT(A1:A3) spills). Optional arguments take `defaults` by position.
 */
export function numericFn(
  name: string,
  minArgs: number,
  maxArgs: number,
  fn: (x: number[], ctx: EvalContext) => number | CellError,
  defaults: ReadonlyArray<number | undefined> = [],
): FunctionSpec {
  return {
    name,
    minArgs,
    maxArgs,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, maxArgs, defaults);
      if (isError(x)) return x;
      const r = fn(x, ctx);
      return isError(r) ? r : numResult(r);
    },
  };
}

export function sumOf(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function flatten(m: Matrix): Scalar[] {
  const out: Scalar[] = [];
  for (const row of m.data) for (const v of row) out.push(v);
  return out;
}

const EMPTY_MATRIX: Matrix = { kind: 'matrix', rows: 0, cols: 0, data: [] };

const usedExtent = clippedExtent;

export interface Aligned {
  /** One matrix per argument, all `rows` × `cols`, lined up cell for cell. */
  mats: Matrix[];
  rows: number;
  cols: number;
  /** Nominal cell count; the cells past rows × cols are known to be blank. */
  total: number;
}

/**
 * Materialises same-shaped range/array arguments so they line up cell for
 * cell (SUMIFS, COUNTIFS, SUMPRODUCT, …). Different shapes are #VALUE!.
 * Whole-column and whole-row references are clipped to the furthest used
 * cell of any of them, so SUMIFS(B:B, A:A, "x") reads the used rows only;
 * `total` lets callers account for the blanks that were clipped off.
 */
export function alignArgs(values: EvalValue[], ctx: EvalContext): Aligned | CellError {
  const shape = arrayShape(values);
  if (isError(shape)) return shape;
  const ranges = values.filter(isRange);
  const extent = shape === null ? referencesExtent(ranges, ctx) : arrayExtent(shape, ranges, ctx);
  if (isError(extent)) return extent;
  const empty = extent.rows === 0 || extent.cols === 0;
  const rows = empty ? 0 : extent.rows;
  const cols = empty ? 0 : extent.cols;
  const mats: Matrix[] = [];
  for (const v of values) {
    const m = alignedMatrix(v, rows, cols, ctx);
    if (isError(m)) return m;
    mats.push(m);
  }
  return { mats, rows, cols, total: extent.total };
}

interface Extent {
  rows: number;
  cols: number;
  /** Nominal cell count, as in Aligned. */
  total: number;
}

/** The shape every non-reference argument shares, null when all are references. Mismatches are #VALUE!. */
function arrayShape(values: EvalValue[]): { rows: number; cols: number } | null | CellError {
  let shape: { rows: number; cols: number } | null = null;
  for (const v of values) {
    if (isError(v)) return v;
    if (isRange(v)) continue;
    const d = dims(v);
    if (shape === null) shape = d;
    else if (d.rows !== shape.rows || d.cols !== shape.cols) return ERR.value;
  }
  return shape;
}

/** Only references: nominal shapes must agree; read up to the furthest used cell. */
function referencesExtent(ranges: RangeRef[], ctx: EvalContext): Extent | CellError {
  const d0 = dims(ranges[0]!);
  let rows = 0;
  let cols = 0;
  for (const r of ranges) {
    const d = dims(r);
    if (d.rows !== d0.rows || d.cols !== d0.cols) return ERR.value;
    const e = usedExtent(r, ctx);
    rows = Math.max(rows, e.rows);
    cols = Math.max(cols, e.cols);
  }
  return { rows, cols, total: d0.rows * d0.cols };
}

/**
 * An array fixes the shape. A whole-column reference still fits when its
 * used part does (A:A next to an array computed from A:A).
 */
function arrayExtent(
  shape: { rows: number; cols: number },
  ranges: RangeRef[],
  ctx: EvalContext,
): Extent | CellError {
  const { rows, cols } = shape;
  let total = rows * cols;
  for (const r of ranges) {
    const d = dims(r);
    if (d.rows === rows && d.cols === cols) continue;
    const e = usedExtent(r, ctx);
    if (d.rows < rows || d.cols < cols || e.rows > rows || e.cols > cols) return ERR.value;
    total = Math.max(total, d.rows * d.cols);
  }
  return { rows, cols, total };
}

/** One argument of alignArgs as a rows × cols matrix (references read from their top-left cell). */
function alignedMatrix(v: EvalValue, rows: number, cols: number, ctx: EvalContext): Matrix | CellError {
  if (isMatrix(v)) return v;
  if (!isRange(v)) return matrix([[v]]);
  if (rows === 0) return EMPTY_MATRIX;
  return toMatrix({ ...v, r2: v.r1 + rows - 1, c2: v.c1 + cols - 1 }, ctx, false);
}

/** SUMIF/AVERAGEIF's result range: Excel resizes it to the criteria range from its top-left cell. */
export function resizeLike(target: EvalValue, like: EvalValue): EvalValue {
  if (!isRange(target)) return target;
  const d = dims(like);
  return {
    ...target,
    r2: Math.min(MAX_ROWS - 1, target.r1 + d.rows - 1),
    c2: Math.min(MAX_COLS - 1, target.c1 + d.cols - 1),
  };
}

export type CriteriaPair = readonly [EvalValue, Scalar];

/** The (range, criterion) pairs of a *IFS call from argument `from` on. */
export function criteriaPairs(args: EvalValue[], from: number, ctx: EvalContext): CriteriaPair[] | CellError {
  const n = args.length - from;
  if (n < 2 || n % 2 !== 0) return { ...ERR.na, message: 'Criteria come in range, criterion pairs' };
  const pairs: CriteriaPair[] = [];
  for (let i = from; i < args.length; i += 2) pairs.push([args[i]!, toScalar(args[i + 1]!, ctx)]);
  return pairs;
}

export interface IfsScan {
  /** Matching cells, clipped-off blanks included when every criterion accepts a blank. */
  count: number;
  /** Values of `target` at the matching cells of the used area. */
  values: Scalar[];
}

/** Tests criteria cell by cell over aligned ranges and collects `target`'s matching values. */
export function scanIfs(target: EvalValue | null, pairs: CriteriaPair[], ctx: EvalContext): IfsScan | CellError {
  const ranges = pairs.map((p) => p[0]);
  const aligned = alignArgs(target === null ? ranges : [target, ...ranges], ctx);
  if (isError(aligned)) return aligned;
  const preds = pairs.map((p) => compileCriteria(p[1]));
  const { mats, rows, cols, total } = aligned;
  const tgt = target === null ? null : mats[0]!;
  const crit = tgt === null ? mats : mats.slice(1);
  let count = 0;
  const values: Scalar[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!allMatch(preds, crit, r, c)) continue;
      count++;
      if (tgt) values.push(tgt.data[r]![c]!);
    }
  }
  if (total > rows * cols && preds.every((p) => p(null))) count += total - rows * cols;
  return { count, values };
}

/** True when every criterion accepts the cell (r, c) of its own matrix. */
function allMatch(preds: ((v: Scalar) => boolean)[], crit: Matrix[], r: number, c: number): boolean {
  for (let k = 0; k < preds.length; k++) {
    if (!preds[k]!(crit[k]!.data[r]![c]!)) return false;
  }
  return true;
}

/** SUMIF / AVERAGEIF scan: (range, criterion, [result range]). */
export function scanIf(args: EvalValue[], ctx: EvalContext): IfsScan | CellError {
  const range = args[0]!;
  const third = args[2];
  const target = third === undefined || third === null ? range : resizeLike(third, range);
  return scanIfs(target, [[range, toScalar(args[1]!, ctx)]], ctx);
}

/** The numbers among matched values; an error at a matching cell propagates. */
export function matchedNumbers(values: Scalar[]): number[] | CellError {
  const out: number[] = [];
  for (const v of values) {
    if (isError(v)) return v;
    if (typeof v === 'number') out.push(v);
  }
  return out;
}

/**
 * Pairs two data sets cell by cell (CORREL, SLOPE, SUMX2MY2, …). Pairs where
 * either side is not a number are dropped, errors propagate, and data sets of
 * different sizes are #N/A.
 */
export function pairedNumbers(a: EvalValue, b: EvalValue, ctx: EvalContext): { xs: number[]; ys: number[] } | CellError {
  const flat = flattenPair(a, b, ctx);
  if (isError(flat)) return flat;
  const { fa, fb } = flat;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < fa.length; i++) {
    const x = fa[i]!;
    const y = fb[i]!;
    if (isError(x)) return x;
    if (isError(y)) return y;
    if (typeof x === 'number' && typeof y === 'number') {
      xs.push(x);
      ys.push(y);
    }
  }
  return { xs, ys };
}

/**
 * pairedNumbers' two data sets, flattened so they line up cell for cell:
 * same-shaped ones are aligned, others only need the same cell count.
 */
function flattenPair(a: EvalValue, b: EvalValue, ctx: EvalContext): { fa: Scalar[]; fb: Scalar[] } | CellError {
  const da = dims(a);
  const db = dims(b);
  if (da.rows === db.rows && da.cols === db.cols) {
    const al = alignArgs([a, b], ctx);
    if (isError(al)) return al;
    return { fa: flatten(al.mats[0]!), fb: flatten(al.mats[1]!) };
  }
  if (da.rows * da.cols !== db.rows * db.cols) return ERR.na;
  const ma = toMatrix(a, ctx);
  if (isError(ma)) return ma;
  const mb = toMatrix(b, ctx);
  if (isError(mb)) return mb;
  const fa = flatten(ma);
  const fb = flatten(mb);
  return fa.length === fb.length ? { fa, fb } : ERR.na;
}

/** Like collectNumbers but in row-major cell order (MODE breaks ties by first occurrence). */
function orderedNumbers(args: EvalValue[], ctx: EvalContext): number[] | CellError {
  const out: number[] = [];
  for (const a of args) {
    if (isRange(a) || isMatrix(a)) {
      const failed = pushGridNumbers(a, ctx, out);
      if (failed) return failed;
    } else {
      const n = toNumber(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** Appends the numbers of a range or array to `out` in row-major order; returns the first error met, if any. */
function pushGridNumbers(a: RangeRef | Matrix, ctx: EvalContext, out: number[]): CellError | null {
  const m = toMatrix(a, ctx);
  if (isError(m)) return m;
  for (const row of m.data) {
    for (const v of row) {
      if (isError(v)) return v;
      if (typeof v === 'number') out.push(v);
    }
  }
  return null;
}

/** Every value of a range or array as a number; anything else is #VALUE! (regression inputs). */
function numericGrid(v: EvalValue, ctx: EvalContext): { rows: number; cols: number; values: number[] } | CellError {
  const m = toMatrix(v, ctx);
  if (isError(m)) return m;
  const values: number[] = [];
  for (const row of m.data) {
    for (const x of row) {
      if (isError(x)) return x;
      if (typeof x !== 'number') return ERR.value;
      values.push(x);
    }
  }
  return { rows: m.rows, cols: m.cols, values };
}

const IFS_FROM_1 = Array.from({ length: 127 }, (_, i) => 1 + 2 * i);
const IFS_FROM_2 = Array.from({ length: 127 }, (_, i) => 2 + 2 * i);

// ---------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

const FACTORIALS: number[] = [1];
for (let i = 1; i <= 170; i++) FACTORIALS.push(FACTORIALS[i - 1]! * i);

/** n! for integer n ≥ 0 (Infinity past 170). */
export function factorial(n: number): number {
  return n <= 170 ? FACTORIALS[n]! : Infinity;
}

function lanczosSum(z: number): number {
  let a = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i]! / (z + i);
  return a;
}

/** ln Γ(x) for x > 0 (Lanczos approximation, ~15 significant digits). */
export function lnGamma(x: number): number {
  if (Number.isInteger(x) && x >= 1 && x <= 171) return Math.log(FACTORIALS[x - 1]!);
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  const t = z + LANCZOS_G + 0.5;
  return LN_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(lanczosSum(z));
}

/** Γ(x); NaN at 0 and the negative integers. */
export function gammaFn(x: number): number {
  if (Number.isInteger(x)) return x <= 0 ? NaN : factorial(x - 1);
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  const z = x - 1;
  const t = z + LANCZOS_G + 0.5;
  const p = Math.pow(t, (z + 0.5) / 2); // split so t^(z+½) does not overflow early
  return SQRT_2PI * p * (p * Math.exp(-t)) * lanczosSum(z);
}

const FPMIN = 1e-300;
const CF_EPS = 1e-15;

function betaCf(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10_000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < CF_EPS) break;
  }
  return h;
}

/**
 * Regularised incomplete beta function I_x(p, q). Past the mean it uses the
 * symmetry I_x(p, q) = 1 − I_{1−x}(q, p), where the continued fraction converges.
 */
export function betaInc(x: number, p: number, q: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(p + q) - lnGamma(p) - lnGamma(q) + p * Math.log(x) + q * Math.log1p(-x));
  if (x < (p + 1) / (p + q + 2)) return (front * betaCf(x, p, q)) / p;
  return 1 - (front * betaCf(1 - x, q, p)) / q;
}

/** Regularised lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) return gammaSeries(a, x);
  return 1 - gammaCf(a, x);
}

/** Regularised upper incomplete gamma Q(a, x) = 1 − P(a, x), without the cancellation. */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaCf(a, x);
}

function gammaSeries(a: number, x: number): number {
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let n = 0; n < 10_000; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * CF_EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

function gammaCf(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 10_000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < CF_EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/**
 * Standard normal CDF via Φ(−|x|) = ½·Q(½, x²/2), which keeps full relative
 * precision far into the tails (Φ(−6) ≈ 9.8659e−10 to ~15 digits).
 */
export function normCdf(x: number): number {
  const tail = 0.5 * gammaQ(0.5, (x * x) / 2);
  return x > 0 ? 1 - tail : tail;
}

export function normPdf(x: number): number {
  return Math.exp((-x * x) / 2) / SQRT_2PI;
}

const ACKLAM_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const ACKLAM_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const ACKLAM_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

function poly(coef: readonly number[], x: number): number {
  let r = 0;
  for (const c of coef) r = r * x + c;
  return r;
}

/** Standard normal quantile, 0 < p < 1 (Acklam, refined with one Halley step). */
export function normInv(p: number): number {
  let x: number;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  } else if (p <= 1 - 0.02425) {
    const q = p - 0.5;
    const r = q * q;
    x = (poly(ACKLAM_A, r) * q) / (poly(ACKLAM_B, r) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p));
    x = -poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/**
 * Root of an increasing function inside [lo, hi] with f(lo) ≤ 0 ≤ f(hi):
 * Newton steps while they stay in the bracket, bisection otherwise.
 */
function solveIncreasing(f: (x: number) => number, df: (x: number) => number, lo: number, hi: number): number {
  let x = (lo + hi) / 2;
  for (let i = 0; i < 400; i++) {
    const fx = f(x);
    if (fx === 0) return x;
    if (fx < 0) lo = x;
    else hi = x;
    const d = df(x);
    let next = x - fx / d;
    // Written so a NaN slope or step also falls back to bisection.
    if (!(d > 0 && next > lo && next < hi)) next = (lo + hi) / 2;
    if (next === x || Math.abs(next - x) <= 1e-15 * Math.abs(next)) return next;
    x = next;
  }
  return x;
}

function tPdf(t: number, df: number): number {
  const lnc = lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI);
  return Math.exp(lnc - ((df + 1) / 2) * Math.log1p((t * t) / df));
}

/** P(T > t) for t ≥ 0. */
function tUpper(t: number, df: number): number {
  const t2 = t * t;
  if (t2 < df) return 0.5 * (1 - betaInc(t2 / (df + t2), 0.5, df / 2));
  return 0.5 * betaInc(df / (df + t2), df / 2, 0.5);
}

function tCdf(t: number, df: number): number {
  return t >= 0 ? 1 - tUpper(t, df) : tUpper(-t, df);
}

/** The t ≥ 0 with P(T > t) = q, 0 < q ≤ 0.5. */
function tUpperInv(q: number, df: number): number {
  if (q >= 0.5) return 0;
  let hi = 1;
  while (tUpper(hi, df) > q && hi < 1e300) hi *= 2;
  return solveIncreasing(
    (t) => q - tUpper(t, df),
    (t) => tPdf(t, df),
    0,
    hi,
  );
}

function chisqPdf(x: number, k: number): number {
  if (x < 0) return 0;
  if (x === 0) {
    if (k === 2) return 0.5;
    return k < 2 ? Infinity : 0;
  }
  return Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.LN2 - lnGamma(k / 2));
}

function chisqInv(p: number, k: number): number {
  if (p <= 0) return 0;
  let hi = Math.max(1, k);
  while (gammaP(k / 2, hi / 2) < p && hi < 1e300) hi *= 2;
  return solveIncreasing(
    (x) => gammaP(k / 2, x / 2) - p,
    (x) => chisqPdf(x, k),
    0,
    hi,
  );
}

/** C(n, k) as a float (exact while it fits in 2^53). */
export function combin(n: number, k: number): number {
  const kk = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= kk; i++) r = (r * (n - kk + i)) / i;
  return r < 2 ** 53 ? Math.round(r) : r;
}

function binomPmf(k: number, n: number, p: number): number {
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  const c = combin(n, k);
  const r = c * Math.pow(p, k) * Math.pow(1 - p, n - k);
  if (Number.isFinite(c) && Number.isFinite(r) && r > 0) return r;
  return Math.exp(lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

function poissonPmf(k: number, mean: number): number {
  if (mean === 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(mean) - mean - lnGamma(k + 1));
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

function mean(xs: readonly number[]): number {
  return sumOf(xs) / xs.length;
}

/** Sum of squared deviations from the mean (two-pass). */
function sumSqDev(xs: readonly number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s;
}

function variance(xs: readonly number[], sample: boolean): number | CellError {
  const n = xs.length;
  if (n === 0 || (sample && n < 2)) return ERR.div0;
  return numResult(sumSqDev(xs) / (sample ? n - 1 : n));
}

function stdev(xs: readonly number[], sample: boolean): number | CellError {
  const v = variance(xs, sample);
  return isError(v) ? v : numResult(Math.sqrt(v));
}

function median(xs: number[]): number | CellError {
  if (xs.length === 0) return ERR.num;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function sorted(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

/** Excel's k for LARGE/SMALL is rounded up. */
function kth(xs: number[], kRaw: number, largest: boolean): number | CellError {
  const k = Math.ceil(kRaw - 1e-12);
  if (k < 1 || k > xs.length) return ERR.num;
  const s = sorted(xs);
  return largest ? s[s.length - k]! : s[k - 1]!;
}

function percentileInc(s: number[], k: number): number | CellError {
  if (s.length === 0 || k < 0 || k > 1) return ERR.num;
  const pos = k * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (pos - lo) * (s[hi]! - s[lo]!);
}

function percentileExc(s: number[], k: number): number | CellError {
  const n = s.length;
  if (n === 0 || k <= 0 || k >= 1) return ERR.num;
  const rank = k * (n + 1);
  if (rank < 1 || rank > n) return ERR.num;
  const lo = Math.floor(rank);
  const hi = Math.min(lo, n - 1);
  return s[lo - 1]! + (rank - lo) * (s[hi]! - s[lo - 1]!);
}

/** Rounds down to `digits` decimals after shedding binary noise (PERCENTRANK's significance). */
function truncDigits(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.floor(Number((v * f).toPrecision(15))) / f;
}

function percentRank(s: number[], x: number, digits: number, exc: boolean): number | CellError {
  const n = s.length;
  if (n === 0) return ERR.num;
  if (digits < 1) return ERR.num;
  if (x < s[0]! || x > s[n - 1]!) return ERR.na;
  let i = 0;
  while (i < n && s[i]! < x) i++;
  const rank = s[i] === x ? i : i - 1 + (x - s[i - 1]!) / (s[i]! - s[i - 1]!);
  let r: number;
  if (exc) r = (rank + 1) / (n + 1);
  else r = n === 1 ? 1 : rank / (n - 1);
  return truncDigits(r, digits);
}

function modes(xs: number[]): { values: number[]; count: number } {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = 1;
  for (const c of counts.values()) best = Math.max(best, c);
  if (best < 2) return { values: [], count: best };
  // Map iteration order is first-occurrence order.
  const values = [...counts].filter(([, c]) => c === best).map(([v]) => v);
  return { values, count: best };
}

function rankOf(x: number, xs: number[], ascending: boolean, average: boolean): number | CellError {
  let before = 0;
  let equal = 0;
  for (const v of xs) {
    if (v === x) equal++;
    else if (ascending ? v < x : v > x) before++;
  }
  if (equal === 0) return ERR.na;
  return average ? before + 1 + (equal - 1) / 2 : before + 1;
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

interface Fit {
  m: number;
  b: number;
  n: number;
  xs: number[];
  ys: number[];
  constant: boolean;
}

function fitLine(xs: number[], ys: number[], constant: boolean): Fit | CellError {
  const n = ys.length;
  if (n === 0) return ERR.value;
  if (constant) {
    const mx = mean(xs);
    const my = mean(ys);
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (xs[i]! - mx) * (xs[i]! - mx);
      sxy += (xs[i]! - mx) * (ys[i]! - my);
    }
    if (sxx === 0) return ERR.div0;
    const m = sxy / sxx;
    return { m, b: my - m * mx, n, xs, ys, constant };
  }
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += xs[i]! * xs[i]!;
    sxy += xs[i]! * ys[i]!;
  }
  if (sxx === 0) return ERR.div0;
  return { m: sxy / sxx, b: 0, n, xs, ys, constant };
}

interface Grid {
  rows: number;
  cols: number;
  values: number[];
}

/** known_y's and known_x's of TREND/GROWTH/LINEST. Only one x variable is supported. */
function regressionInput(
  args: EvalValue[],
  ctx: EvalContext,
): { ys: number[]; xs: Grid } | CellError {
  const y = numericGrid(args[0]!, ctx);
  if (isError(y)) return y;
  const xArg = args[1];
  if (xArg === undefined || xArg === null) {
    return { ys: y.values, xs: { rows: y.rows, cols: y.cols, values: y.values.map((_, i) => i + 1) } };
  }
  const x = numericGrid(xArg, ctx);
  if (isError(x)) return x;
  if (x.values.length !== y.values.length) return { ...ERR.ref, message: 'Only one x variable is supported' };
  return { ys: y.values, xs: x };
}

function readConst(args: EvalValue[], i: number, ctx: EvalContext): boolean | CellError {
  const v = args[i];
  return v === undefined || v === null ? true : bool(v, ctx);
}

function predict(args: EvalValue[], ctx: EvalContext, exponential: boolean): EvalValue {
  const input = regressionInput(args, ctx);
  if (isError(input)) return input;
  const constant = readConst(args, 3, ctx);
  if (isError(constant)) return constant;
  let ys = input.ys;
  if (exponential) {
    if (ys.some((v) => v <= 0)) return ERR.num;
    ys = ys.map(Math.log);
  }
  const fit = fitLine(input.xs.values, ys, constant);
  if (isError(fit)) return fit;
  const newArg = args[2];
  const nx = newArg === undefined || newArg === null ? input.xs : numericGrid(newArg, ctx);
  if (isError(nx)) return nx;
  const data: Scalar[][] = [];
  for (let r = 0; r < nx.rows; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < nx.cols; c++) {
      const v = fit.b + fit.m * nx.values[r * nx.cols + c]!;
      row.push(numResult(exponential ? Math.exp(v) : v));
    }
    data.push(row);
  }
  return matrix(data);
}

function linestStats(fit: Fit): Scalar[][] {
  const { m, b, n, xs, ys, constant } = fit;
  const df = constant ? n - 2 : n - 1;
  const my = constant ? mean(ys) : 0;
  const mx = constant ? mean(xs) : 0;
  let ssResid = 0;
  let ssTot = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const yhat = m * xs[i]! + b;
    ssResid += (ys[i]! - yhat) ** 2;
    ssTot += (ys[i]! - my) ** 2;
    sxx += (xs[i]! - mx) ** 2;
  }
  const ssReg = ssTot - ssResid;
  const r2 = ssTot === 0 ? 1 : ssReg / ssTot;
  const seY = Math.sqrt(ssResid / df);
  const seM = seY / Math.sqrt(sxx);
  const seB: Scalar = constant ? numResult(seY * Math.sqrt(1 / n + (mx * mx) / sxx)) : ERR.na;
  const f = ssReg / (ssResid / df);
  return [
    [numResult(m), numResult(b)],
    [numResult(seM), seB],
    [numResult(r2), numResult(seY)],
    [numResult(f), df],
    [numResult(ssReg), numResult(ssResid)],
  ];
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

function aggregate(
  name: string,
  collect: (args: EvalValue[], ctx: EvalContext) => number[] | CellError,
  fn: (xs: number[]) => number | CellError,
  minArgs = 1,
): FunctionSpec {
  return {
    name,
    minArgs,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = collect(args, ctx);
      if (isError(xs)) return xs;
      const r = fn(xs);
      return isError(r) ? r : numResult(r);
    },
  };
}

const avg = (xs: number[]): number | CellError => (xs.length ? mean(xs) : ERR.div0);
const maxOf = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => (b > a ? b : a)) : 0);
const minOf = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => (b < a ? b : a)) : 0);

function modeSngl(name: string): FunctionSpec {
  return {
    name,
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = orderedNumbers(args, ctx);
      if (isError(xs)) return xs;
      const m = modes(xs);
      return m.values.length ? m.values[0]! : ERR.na;
    },
  };
}

function rankFn(name: string, average: boolean): FunctionSpec {
  return {
    name,
    minArgs: 2,
    maxArgs: 3,
    scalarArgs: [0, 2],
    impl(args, ctx) {
      const x = num(args[0]!, ctx);
      if (isError(x)) return x;
      const order = args[2] === undefined || args[2] === null ? 0 : num(args[2], ctx);
      if (isError(order)) return order;
      const xs = collectNumbers([args[1]!], ctx);
      if (isError(xs)) return xs;
      return rankOf(x, xs, order !== 0, average);
    },
  };
}

function percentileFn(name: string, pick: (s: number[], k: number) => number | CellError): FunctionSpec {
  return {
    name,
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: [1],
    impl(args, ctx) {
      const k = num(args[1]!, ctx);
      if (isError(k)) return k;
      const xs = collectNumbers([args[0]!], ctx);
      if (isError(xs)) return xs;
      const r = pick(sorted(xs), k);
      return isError(r) ? r : numResult(r);
    },
  };
}

function quartileFn(name: string, exc: boolean): FunctionSpec {
  return percentileFn(name, (s, q) => {
    const quart = Math.trunc(q);
    if (exc ? quart < 1 || quart > 3 : quart < 0 || quart > 4) return ERR.num;
    return exc ? percentileExc(s, quart / 4) : percentileInc(s, quart / 4);
  });
}

function percentRankFn(name: string, exc: boolean): FunctionSpec {
  return {
    name,
    minArgs: 2,
    maxArgs: 3,
    scalarArgs: [1, 2],
    impl(args, ctx) {
      const p = readNums(args.slice(1), ctx, 2, [undefined, 3]);
      if (isError(p)) return p;
      const xs = collectNumbers([args[0]!], ctx);
      if (isError(xs)) return xs;
      return percentRank(sorted(xs), p[0]!, Math.trunc(p[1]!), exc);
    },
  };
}

function varianceFns(names: string[], collect: typeof collectNumbers, sample: boolean, root: boolean): FunctionSpec[] {
  return names.map((name) =>
    aggregate(name, collect, (xs) => (root ? stdev(xs, sample) : variance(xs, sample))),
  );
}

function pairFn(name: string, fn: (xs: number[], ys: number[]) => number | CellError): FunctionSpec {
  return {
    name,
    minArgs: 2,
    maxArgs: 2,
    impl(args, ctx) {
      const p = pairedNumbers(args[0]!, args[1]!, ctx);
      if (isError(p)) return p;
      const r = fn(p.xs, p.ys);
      return isError(r) ? r : numResult(r);
    },
  };
}

function correl(xs: number[], ys: number[]): number | CellError {
  if (xs.length < 2) return ERR.div0;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return ERR.div0;
  return sxy / Math.sqrt(sxx * syy);
}

function covariance(xs: number[], ys: number[], sample: boolean): number | CellError {
  const n = xs.length;
  if (n === 0 || (sample && n < 2)) return ERR.div0;
  const mx = mean(xs);
  const my = mean(ys);
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i]! - mx) * (ys[i]! - my);
  return s / (sample ? n - 1 : n);
}

/** SLOPE/INTERCEPT/FORECAST take (known_y, known_x): ys come first. */
function lineFit(ys: number[], xs: number[]): Fit | CellError {
  if (ys.length === 0) return ERR.div0;
  return fitLine(xs, ys, true);
}

function ifsAggregate(
  name: string,
  fn: (values: number[]) => number | CellError,
): FunctionSpec {
  return {
    name,
    minArgs: 3,
    maxArgs: 255,
    scalarArgs: IFS_FROM_2,
    impl(args, ctx) {
      const pairs = criteriaPairs(args, 1, ctx);
      if (isError(pairs)) return pairs;
      const scan = scanIfs(args[0]!, pairs, ctx);
      if (isError(scan)) return scan;
      const xs = matchedNumbers(scan.values);
      if (isError(xs)) return xs;
      const r = fn(xs);
      return isError(r) ? r : numResult(r);
    },
  };
}

function normDist(x: number, m: number, sd: number, cumulative: boolean): number | CellError {
  if (sd <= 0) return ERR.num;
  const z = (x - m) / sd;
  return cumulative ? normCdf(z) : normPdf(z) / sd;
}

function normDistFn(name: string): FunctionSpec {
  return {
    name,
    minArgs: 4,
    maxArgs: 4,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, 3);
      if (isError(x)) return x;
      const cum = bool(args[3]!, ctx);
      if (isError(cum)) return cum;
      const r = normDist(x[0]!, x[1]!, x[2]!, cum);
      return isError(r) ? r : numResult(r);
    },
  };
}

function normInvFn(name: string): FunctionSpec {
  return numericFn(name, 3, 3, ([p, m, sd]) => {
    if (p! <= 0 || p! >= 1 || sd! <= 0) return ERR.num;
    return m! + sd! * normInv(p!);
  });
}

function normSInvFn(name: string): FunctionSpec {
  return numericFn(name, 1, 1, ([p]) => (p! <= 0 || p! >= 1 ? ERR.num : normInv(p!)));
}

function binomDist(name: string): FunctionSpec {
  return {
    name,
    minArgs: 4,
    maxArgs: 4,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, 3);
      if (isError(x)) return x;
      const cum = bool(args[3]!, ctx);
      if (isError(cum)) return cum;
      const k = Math.trunc(x[0]!);
      const n = Math.trunc(x[1]!);
      const p = x[2]!;
      if (k < 0 || n < 0 || k > n || p < 0 || p > 1) return ERR.num;
      if (!cum) return numResult(binomPmf(k, n, p));
      if (k >= n) return 1;
      return numResult(betaInc(1 - p, n - k, k + 1));
    },
  };
}

function poissonDist(name: string): FunctionSpec {
  return {
    name,
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, 2);
      if (isError(x)) return x;
      const cum = bool(args[2]!, ctx);
      if (isError(cum)) return cum;
      const k = Math.trunc(x[0]!);
      const m = x[1]!;
      if (k < 0 || m < 0) return ERR.num;
      if (!cum) return numResult(poissonPmf(k, m));
      return m === 0 ? 1 : numResult(gammaQ(k + 1, m));
    },
  };
}

function exponDist(name: string): FunctionSpec {
  return {
    name,
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, 2);
      if (isError(x)) return x;
      const cum = bool(args[2]!, ctx);
      if (isError(cum)) return cum;
      const v = x[0]!;
      const lambda = x[1]!;
      if (v < 0 || lambda <= 0) return ERR.num;
      return numResult(cum ? -Math.expm1(-lambda * v) : lambda * Math.exp(-lambda * v));
    },
  };
}

function confidenceNorm(name: string): FunctionSpec {
  return numericFn(name, 3, 3, ([alpha, sd, sizeRaw]) => {
    const size = Math.trunc(sizeRaw!);
    if (alpha! <= 0 || alpha! >= 1 || sd! <= 0 || size < 1) return ERR.num;
    return (normInv(1 - alpha! / 2) * sd!) / Math.sqrt(size);
  });
}

function gammaLnFn(name: string): FunctionSpec {
  return numericFn(name, 1, 1, ([x]) => (x! <= 0 ? ERR.num : lnGamma(x!)));
}

/** COUNT's rule: numbers anywhere; typed directly, also blanks, booleans and numeric text. */
function countsAsNumber(v: Scalar, direct: boolean): boolean {
  if (typeof v === 'number') return true;
  if (!direct) return false;
  if (v === null || typeof v === 'boolean') return true;
  return typeof v === 'string' && !isError(toNumber(v));
}

function freedom(raw: number): number | CellError {
  const df = Math.trunc(raw);
  return df < 1 || df > 1e10 ? ERR.num : df;
}

export const statsFunctions: FunctionSpec[] = [
  // --- averages and counts -------------------------------------------------
  aggregate('AVERAGE', collectNumbers, avg),
  aggregate('AVERAGEA', collectNumbersA, avg),
  {
    name: 'COUNT',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      let n = 0;
      visitArgs(args, ctx, (v, direct) => {
        if (countsAsNumber(v, direct)) n++;
      });
      return n;
    },
  },
  {
    name: 'COUNTA',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      let n = 0;
      visitArgs(args, ctx, () => {
        n++;
      });
      return n;
    },
  },
  {
    name: 'COUNTBLANK',
    minArgs: 1,
    maxArgs: 1,
    impl(args, ctx) {
      const a = args[0]!;
      if (isRange(a)) {
        const d = dims(a);
        let filled = 0;
        ctx.host.forEachValue(a.sheetId, a, (_r, _c, v) => {
          if (v !== '') filled++;
        });
        return d.rows * d.cols - filled;
      }
      if (isMatrix(a)) {
        let n = 0;
        for (const row of a.data) for (const v of row) if (v === null || v === '') n++;
        return n;
      }
      return a === null || a === '' ? 1 : 0;
    },
  },
  {
    name: 'COUNTIF',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: [1],
    impl(args, ctx) {
      const scan = scanIfs(null, [[args[0]!, toScalar(args[1]!, ctx)]], ctx);
      return isError(scan) ? scan : scan.count;
    },
  },
  {
    name: 'COUNTIFS',
    minArgs: 2,
    maxArgs: 254,
    scalarArgs: IFS_FROM_1,
    impl(args, ctx) {
      const pairs = criteriaPairs(args, 0, ctx);
      if (isError(pairs)) return pairs;
      const scan = scanIfs(null, pairs, ctx);
      return isError(scan) ? scan : scan.count;
    },
  },
  {
    name: 'AVERAGEIF',
    minArgs: 2,
    maxArgs: 3,
    scalarArgs: [1],
    impl(args, ctx) {
      const scan = scanIf(args, ctx);
      if (isError(scan)) return scan;
      const xs = matchedNumbers(scan.values);
      if (isError(xs)) return xs;
      return xs.length ? numResult(mean(xs)) : ERR.div0;
    },
  },
  ifsAggregate('AVERAGEIFS', avg),
  ifsAggregate('MAXIFS', maxOf),
  ifsAggregate('MINIFS', minOf),

  // --- extremes and order statistics ---------------------------------------
  aggregate('MAX', collectNumbers, maxOf),
  aggregate('MAXA', collectNumbersA, maxOf),
  aggregate('MIN', collectNumbers, minOf),
  aggregate('MINA', collectNumbersA, minOf),
  aggregate('MEDIAN', collectNumbers, median),
  modeSngl('MODE'),
  modeSngl('MODE.SNGL'),
  {
    name: 'MODE.MULT',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = orderedNumbers(args, ctx);
      if (isError(xs)) return xs;
      const m = modes(xs);
      if (!m.values.length) return ERR.na;
      return matrix(m.values.map((v) => [v]));
    },
  },
  {
    name: 'LARGE',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: [1],
    impl(args, ctx) {
      const k = num(args[1]!, ctx);
      if (isError(k)) return k;
      const xs = collectNumbers([args[0]!], ctx);
      return isError(xs) ? xs : kth(xs, k, true);
    },
  },
  {
    name: 'SMALL',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: [1],
    impl(args, ctx) {
      const k = num(args[1]!, ctx);
      if (isError(k)) return k;
      const xs = collectNumbers([args[0]!], ctx);
      return isError(xs) ? xs : kth(xs, k, false);
    },
  },
  rankFn('RANK', false),
  rankFn('RANK.EQ', false),
  rankFn('RANK.AVG', true),
  percentileFn('PERCENTILE', percentileInc),
  percentileFn('PERCENTILE.INC', percentileInc),
  percentileFn('PERCENTILE.EXC', percentileExc),
  quartileFn('QUARTILE', false),
  quartileFn('QUARTILE.INC', false),
  quartileFn('QUARTILE.EXC', true),
  percentRankFn('PERCENTRANK', false),
  percentRankFn('PERCENTRANK.INC', false),
  percentRankFn('PERCENTRANK.EXC', true),
  {
    name: 'TRIMMEAN',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: [1],
    impl(args, ctx) {
      const pct = num(args[1]!, ctx);
      if (isError(pct)) return pct;
      const xs = collectNumbers([args[0]!], ctx);
      if (isError(xs)) return xs;
      if (xs.length === 0 || pct < 0 || pct >= 1) return ERR.num;
      // Excluded points are rounded down to an even number, half from each end.
      const k = Math.floor(Number(((xs.length * pct) / 2).toPrecision(15)));
      return numResult(mean(sorted(xs).slice(k, xs.length - k)));
    },
  },
  {
    name: 'FREQUENCY',
    minArgs: 2,
    maxArgs: 2,
    impl(args, ctx) {
      const data = collectNumbers([args[0]!], ctx);
      if (isError(data)) return data;
      const bins = orderedNumbers([args[1]!], ctx);
      if (isError(bins)) return bins;
      const order = bins.map((b, i) => [b, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const counts = new Array<number>(bins.length + 1).fill(0);
      for (const x of data) {
        let lo = 0;
        let hi = order.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (order[mid]![0] >= x) hi = mid;
          else lo = mid + 1;
        }
        const slot = lo < order.length ? order[lo]![1] : bins.length;
        counts[slot] = counts[slot]! + 1;
      }
      return matrix(counts.map((c) => [c]));
    },
  },

  // --- dispersion ----------------------------------------------------------
  ...varianceFns(['STDEV', 'STDEV.S'], collectNumbers, true, true),
  ...varianceFns(['STDEVP', 'STDEV.P'], collectNumbers, false, true),
  ...varianceFns(['STDEVA'], collectNumbersA, true, true),
  ...varianceFns(['STDEVPA'], collectNumbersA, false, true),
  ...varianceFns(['VAR', 'VAR.S'], collectNumbers, true, false),
  ...varianceFns(['VARP', 'VAR.P'], collectNumbers, false, false),
  ...varianceFns(['VARA'], collectNumbersA, true, false),
  ...varianceFns(['VARPA'], collectNumbersA, false, false),
  aggregate('AVEDEV', collectNumbers, (xs) => {
    if (!xs.length) return ERR.num;
    const m = mean(xs);
    return mean(xs.map((x) => Math.abs(x - m)));
  }),
  aggregate('DEVSQ', collectNumbers, (xs) => (xs.length ? sumSqDev(xs) : ERR.num)),
  aggregate('GEOMEAN', collectNumbers, (xs) => {
    if (!xs.length || xs.some((x) => x <= 0)) return ERR.num;
    return Math.exp(mean(xs.map(Math.log)));
  }),
  aggregate('HARMEAN', collectNumbers, (xs) => {
    if (!xs.length || xs.some((x) => x <= 0)) return ERR.num;
    return xs.length / sumOf(xs.map((x) => 1 / x));
  }),
  aggregate('SKEW', collectNumbers, (xs) => {
    const n = xs.length;
    if (n < 3) return ERR.div0;
    const m = mean(xs);
    const s = Math.sqrt(sumSqDev(xs) / (n - 1));
    if (s === 0) return ERR.div0;
    let acc = 0;
    for (const x of xs) acc += ((x - m) / s) ** 3;
    return (n / ((n - 1) * (n - 2))) * acc;
  }),
  aggregate('KURT', collectNumbers, (xs) => {
    const n = xs.length;
    if (n < 4) return ERR.div0;
    const m = mean(xs);
    const s = Math.sqrt(sumSqDev(xs) / (n - 1));
    if (s === 0) return ERR.div0;
    let acc = 0;
    for (const x of xs) acc += ((x - m) / s) ** 4;
    return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * acc - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  }),
  numericFn('STANDARDIZE', 3, 3, ([x, m, sd]) => (sd! <= 0 ? ERR.num : (x! - m!) / sd!)),
  numericFn('FISHER', 1, 1, ([x]) => (x! <= -1 || x! >= 1 ? ERR.num : 0.5 * Math.log((1 + x!) / (1 - x!)))),
  numericFn('FISHERINV', 1, 1, ([y]) => Math.tanh(y!)),

  // --- correlation and regression ------------------------------------------
  pairFn('CORREL', correl),
  pairFn('PEARSON', correl),
  pairFn('RSQ', (xs, ys) => {
    const r = correl(xs, ys);
    return isError(r) ? r : r * r;
  }),
  pairFn('COVAR', (xs, ys) => covariance(xs, ys, false)),
  pairFn('COVARIANCE.P', (xs, ys) => covariance(xs, ys, false)),
  pairFn('COVARIANCE.S', (xs, ys) => covariance(xs, ys, true)),
  pairFn('SLOPE', (ys, xs) => {
    const f = lineFit(ys, xs);
    return isError(f) ? f : f.m;
  }),
  pairFn('INTERCEPT', (ys, xs) => {
    const f = lineFit(ys, xs);
    return isError(f) ? f : f.b;
  }),
  pairFn('STEYX', (ys, xs) => {
    const n = ys.length;
    if (n < 3) return ERR.div0;
    const f = fitLine(xs, ys, true);
    if (isError(f)) return f;
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (ys[i]! - (f.m * xs[i]! + f.b)) ** 2;
    return Math.sqrt(ss / (n - 2));
  }),
  ...['FORECAST', 'FORECAST.LINEAR'].map(
    (name): FunctionSpec => ({
      name,
      minArgs: 3,
      maxArgs: 3,
      scalarArgs: [0],
      impl(args, ctx) {
        const x = num(args[0]!, ctx);
        if (isError(x)) return x;
        const p = pairedNumbers(args[1]!, args[2]!, ctx);
        if (isError(p)) return p;
        const f = lineFit(p.xs /* known_y */, p.ys /* known_x */);
        return isError(f) ? f : numResult(f.b + f.m * x);
      },
    }),
  ),
  {
    name: 'TREND',
    minArgs: 1,
    maxArgs: 4,
    impl: (args, ctx) => predict(args, ctx, false),
  },
  {
    name: 'GROWTH',
    minArgs: 1,
    maxArgs: 4,
    impl: (args, ctx) => predict(args, ctx, true),
  },
  {
    // Single x variable only; multiple regression is not implemented.
    name: 'LINEST',
    minArgs: 1,
    maxArgs: 4,
    impl(args, ctx) {
      const input = regressionInput(args, ctx);
      if (isError(input)) return input;
      const constant = readConst(args, 2, ctx);
      if (isError(constant)) return constant;
      const withStats = args[3] === undefined || args[3] === null ? false : bool(args[3], ctx);
      if (isError(withStats)) return withStats;
      const fit = fitLine(input.xs.values, input.ys, constant);
      if (isError(fit)) return fit;
      return matrix(withStats ? linestStats(fit) : [[numResult(fit.m), numResult(fit.b)]]);
    },
  },
  {
    name: 'PROB',
    minArgs: 3,
    maxArgs: 4,
    impl(args, ctx) {
      const bounds = readNums(args.slice(2), ctx, 2, [undefined, Number.NaN]);
      if (isError(bounds)) return bounds;
      const lower = bounds[0]!;
      const upper = Number.isNaN(bounds[1]!) ? lower : bounds[1]!;
      const p = pairedNumbers(args[0]!, args[1]!, ctx);
      if (isError(p)) return p;
      let total = 0;
      let inside = 0;
      for (let i = 0; i < p.xs.length; i++) {
        const pr = p.ys[i]!;
        if (pr < 0 || pr > 1) return ERR.num;
        total += pr;
        if (p.xs[i]! >= lower && p.xs[i]! <= upper) inside += pr;
      }
      if (Math.abs(total - 1) > 1e-9) return ERR.num;
      return numResult(inside);
    },
  },

  // --- distributions -------------------------------------------------------
  normDistFn('NORM.DIST'),
  normDistFn('NORMDIST'),
  normInvFn('NORM.INV'),
  normInvFn('NORMINV'),
  {
    name: 'NORM.S.DIST',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: 'all',
    impl(args, ctx) {
      const z = num(args[0]!, ctx);
      if (isError(z)) return z;
      const cum = bool(args[1]!, ctx);
      if (isError(cum)) return cum;
      return numResult(cum ? normCdf(z) : normPdf(z));
    },
  },
  numericFn('NORMSDIST', 1, 1, ([z]) => normCdf(z!)),
  normSInvFn('NORM.S.INV'),
  normSInvFn('NORMSINV'),
  binomDist('BINOM.DIST'),
  binomDist('BINOMDIST'),
  poissonDist('POISSON.DIST'),
  poissonDist('POISSON'),
  exponDist('EXPON.DIST'),
  exponDist('EXPONDIST'),
  numericFn('GAMMA', 1, 1, ([x]) => {
    const g = gammaFn(x!);
    return Number.isNaN(g) ? ERR.num : g;
  }),
  gammaLnFn('GAMMALN'),
  gammaLnFn('GAMMALN.PRECISE'),
  {
    name: 'T.DIST',
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, 2);
      if (isError(x)) return x;
      const cum = bool(args[2]!, ctx);
      if (isError(cum)) return cum;
      const t = x[0]!;
      const df = Math.trunc(x[1]!);
      if (df < 1) return ERR.num;
      return numResult(cum ? tCdf(t, df) : tPdf(t, df));
    },
  },
  numericFn('T.DIST.2T', 2, 2, ([t, dfRaw]) => {
    const df = Math.trunc(dfRaw!);
    if (t! < 0 || df < 1) return ERR.num;
    return 2 * tUpper(t!, df);
  }),
  numericFn('T.DIST.RT', 2, 2, ([t, dfRaw]) => {
    const df = Math.trunc(dfRaw!);
    if (df < 1) return ERR.num;
    return t! >= 0 ? tUpper(t!, df) : 1 - tUpper(-t!, df);
  }),
  numericFn('T.INV', 2, 2, ([p, dfRaw]) => {
    const df = Math.trunc(dfRaw!);
    if (p! <= 0 || p! >= 1 || df < 1) return ERR.num;
    return p! < 0.5 ? -tUpperInv(p!, df) : tUpperInv(1 - p!, df);
  }),
  numericFn('T.INV.2T', 2, 2, ([p, dfRaw]) => {
    const df = Math.trunc(dfRaw!);
    if (p! <= 0 || p! > 1 || df < 1) return ERR.num;
    return tUpperInv(p! / 2, df);
  }),
  {
    name: 'CHISQ.DIST',
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: 'all',
    impl(args, ctx) {
      const x = readNums(args, ctx, 2);
      if (isError(x)) return x;
      const cum = bool(args[2]!, ctx);
      if (isError(cum)) return cum;
      const df = freedom(x[1]!);
      if (isError(df)) return df;
      if (x[0]! < 0) return ERR.num;
      return numResult(cum ? gammaP(df / 2, x[0]! / 2) : chisqPdf(x[0]!, df));
    },
  },
  numericFn('CHISQ.INV', 2, 2, ([p, dfRaw]) => {
    const df = freedom(dfRaw!);
    if (isError(df)) return df;
    if (p! < 0 || p! >= 1) return ERR.num;
    return chisqInv(p!, df);
  }),
  confidenceNorm('CONFIDENCE'),
  confidenceNorm('CONFIDENCE.NORM'),
  numericFn('CONFIDENCE.T', 3, 3, ([alpha, sd, sizeRaw]) => {
    const size = Math.trunc(sizeRaw!);
    if (alpha! <= 0 || alpha! >= 1 || sd! <= 0 || size < 1) return ERR.num;
    if (size === 1) return ERR.div0;
    return (tUpperInv(alpha! / 2, size - 1) * sd!) / Math.sqrt(size);
  }),
];
