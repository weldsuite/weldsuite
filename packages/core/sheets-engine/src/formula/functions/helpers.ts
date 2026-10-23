/**
 * Building blocks for the function library. Every family file uses these so
 * argument coercion follows one set of (Excel) rules.
 */

import {
  ERR,
  isError,
  isMatrix,
  isRange,
  toBoolean,
  toNumber,
  toText,
  compareScalars,
  parseNumericText,
  type CellError,
  type EvalValue,
  type Matrix,
  type RangeRef,
  type Scalar,
} from '../../values';
import { isDateFormat } from '../../format/number-format';
import { parseInput } from '../../format/input';
import { toMatrix, toScalar } from '../evaluator';
import type { EvalContext } from '../types';

export { toMatrix, toScalar };

/** Scalar argument as a number (arguments are already scalars when listed in `scalarArgs`). */
export function num(v: EvalValue, ctx: EvalContext): number | CellError {
  return toNumber(toScalar(v, ctx));
}

/** Integer argument, truncated toward zero as Excel does. */
export function int(v: EvalValue, ctx: EvalContext): number | CellError {
  const n = num(v, ctx);
  return isError(n) ? n : Math.trunc(n);
}

export function text(v: EvalValue, ctx: EvalContext): string | CellError {
  return toText(toScalar(v, ctx));
}

export function bool(v: EvalValue, ctx: EvalContext): boolean | CellError {
  return toBoolean(toScalar(v, ctx));
}

/** Optional argument: `undefined` (omitted) or null (empty, as in F(A1,,2)) gives the default. */
export function opt<T>(
  args: EvalValue[],
  i: number,
  fallback: T,
  read: (v: EvalValue) => T | CellError,
): T | CellError {
  const v = args[i];
  if (v === undefined || v === null) return fallback;
  return read(v);
}

/**
 * Visits the values an aggregate sees, with Excel's split rules: a value typed
 * directly as an argument is coerced (TRUE counts as 1, "3" as 3), while text
 * and booleans inside ranges and arrays are reported as-is for the caller to
 * skip. Blank cells inside ranges are not visited.
 *
 * Return `false` from `fn` to stop early.
 */
export function visitArgs(
  args: EvalValue[],
  ctx: EvalContext,
  fn: (value: Scalar, direct: boolean) => boolean | void,
): void {
  for (const a of args) {
    let keepGoing: boolean;
    if (isRange(a)) keepGoing = visitRange(a, ctx, fn);
    else if (isMatrix(a)) keepGoing = visitMatrix(a, fn);
    else keepGoing = fn(a, true) !== false;
    if (!keepGoing) return;
  }
}

/** visitArgs for one range argument; false when `fn` asked to stop. */
function visitRange(
  range: RangeRef,
  ctx: EvalContext,
  fn: (value: Scalar, direct: boolean) => boolean | void,
): boolean {
  let stop = false;
  ctx.host.forEachValue(range.sheetId, range, (_r, _c, value) => {
    if (stop) return;
    if (fn(value, false) === false) stop = true;
  });
  return !stop;
}

/** visitArgs for one array argument (blanks skipped); false when `fn` asked to stop. */
function visitMatrix(m: Matrix, fn: (value: Scalar, direct: boolean) => boolean | void): boolean {
  for (const row of m.data) {
    for (const value of row) {
      if (value !== null && fn(value, false) === false) return false;
    }
  }
  return true;
}

/**
 * The numbers SUM/AVERAGE/MIN/… operate on. Errors anywhere propagate; text
 * typed directly must be numeric; text and booleans in ranges are ignored.
 */
export function collectNumbers(args: EvalValue[], ctx: EvalContext): number[] | CellError {
  const out: number[] = [];
  let error: CellError | null = null;
  visitArgs(args, ctx, (v, direct) => {
    if (isError(v)) {
      error = v;
      return false;
    }
    if (typeof v === 'number') out.push(v);
    else if (direct) {
      const n = toNumber(v);
      if (isError(n)) {
        error = n;
        return false;
      }
      out.push(n);
    }
  });
  return error ?? out;
}

/** Like collectNumbers but text and booleans in ranges count as 0/1 (the …A functions). */
export function collectNumbersA(args: EvalValue[], ctx: EvalContext): number[] | CellError {
  const out: number[] = [];
  let error: CellError | null = null;
  visitArgs(args, ctx, (v, direct) => {
    if (isError(v)) {
      error = v;
      return false;
    }
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'boolean') out.push(v ? 1 : 0);
    else if (typeof v === 'string') {
      if (direct) {
        const n = toNumber(v);
        if (isError(n)) {
          error = n;
          return false;
        }
        out.push(n);
      } else {
        out.push(0);
      }
    }
  });
  return error ?? out;
}

/** Rectangular values of a range or array argument (dense, blanks as null). */
export function values2d(v: EvalValue, ctx: EvalContext): Scalar[][] | CellError {
  const m = toMatrix(v, ctx);
  return isError(m) ? m : m.data;
}

/** Dimensions of a range or array argument without materialising it. */
export function dims(v: EvalValue): { rows: number; cols: number } {
  if (isRange(v)) return { rows: v.r2 - v.r1 + 1, cols: v.c2 - v.c1 + 1 };
  if (isMatrix(v)) return { rows: v.rows, cols: v.cols };
  return { rows: 1, cols: 1 };
}

/** Number result guard: NaN and ±Infinity become #NUM!, -0 becomes 0. */
export function finite(n: number): number | CellError {
  if (!Number.isFinite(n)) return ERR.num;
  return n === 0 ? 0 : n;
}

// ---------------------------------------------------------------------------
// Criteria (COUNTIF, SUMIFS, …)
// ---------------------------------------------------------------------------

/**
 * Compiles a COUNTIF-style criterion: 5, ">=10", "<>done", "a*", "=" (blank),
 * "" (blank). Text matches case-insensitively with * ? and ~ escapes.
 */
export function compileCriteria(criterion: Scalar): (v: Scalar) => boolean {
  if (isError(criterion)) {
    const code = criterion.code;
    return (v) => isError(v) && v.code === code;
  }
  if (typeof criterion === 'number' || typeof criterion === 'boolean') {
    return (v) => v === criterion || (typeof criterion === 'number' && typeof v === 'string' && parseNumericText(v) === criterion);
  }
  if (criterion === null) return (v) => v === null || v === 0;

  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(criterion)!;
  const op = m[1] ?? '=';
  const operand = m[2]!;

  if (operand === '') {
    if (op === '=') return (v) => v === null || v === '';
    if (op === '<>') return (v) => v !== null && v !== '';
  }

  const n = parseNumericText(operand) ?? dateOperand(operand);
  if (n !== null) return numberCriterion(op, n);

  const upper = operand.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return booleanCriterion(op, upper === 'TRUE');

  return textCriterion(op, operand);
}

/** A date or time typed as a criterion (">1/1/2025", "<=2025-01-31") as its serial, else null. */
function dateOperand(operand: string): number | null {
  const parsed = parseInput(operand);
  return parsed.kind === 'value' && typeof parsed.value === 'number' && parsed.numFmt && isDateFormat(parsed.numFmt)
    ? parsed.value
    : null;
}

/**
 * A criterion with a numeric operand (">=10"): numbers compare; for = and <>
 * text that reads as the same number counts as equal ("5" matches 5), as in
 * Excel; the ordering operators ignore text.
 */
function numberCriterion(op: string, target: number): (v: Scalar) => boolean {
  const test = (x: number): boolean => {
    switch (op) {
      case '=':
        return x === target;
      case '<>':
        return x !== target;
      case '<':
        return x < target;
      case '>':
        return x > target;
      case '<=':
        return x <= target;
      default:
        return x >= target;
    }
  };
  return (v) => {
    if (typeof v === 'number') return test(v);
    const asNumber = typeof v === 'string' && (op === '=' || op === '<>') ? parseNumericText(v) : null;
    if (asNumber !== null) return test(asNumber);
    return op === '<>';
  };
}

/** A criterion with a TRUE/FALSE operand; ordering operators match nothing. */
function booleanCriterion(op: string, b: boolean): (v: Scalar) => boolean {
  if (op === '<>') return (v) => v !== b;
  if (op === '=') return (v) => v === b;
  return () => false;
}

/** A criterion with a text operand: = and <> match wildcards, the ordering operators compare text only. */
function textCriterion(op: string, operand: string): (v: Scalar) => boolean {
  if (op === '=' || op === '<>') {
    const re = wildcardRegExp(operand);
    const eq = (v: Scalar) => typeof v === 'string' && re.test(v);
    return op === '=' ? eq : (v) => !eq(v);
  }
  return (v) => {
    if (typeof v !== 'string') return false;
    const c = compareScalars(v, operand);
    switch (op) {
      case '<':
        return c < 0;
      case '>':
        return c > 0;
      case '<=':
        return c <= 0;
      default:
        return c >= 0;
    }
  };
}

/** Excel wildcards: * any run, ? one char, ~ escapes. Whole-string, case-insensitive. */
export function wildcardRegExp(pattern: string): RegExp {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '~' && i + 1 < pattern.length) {
      src += escapeRe(pattern[++i]!);
    } else if (ch === '*') src += '[\\s\\S]*';
    else if (ch === '?') src += '[\\s\\S]';
    else src += escapeRe(ch);
  }
  return new RegExp(`^${src}$`, 'i');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the pattern uses wildcards (lookups only switch to wildcard mode then). */
export function hasWildcards(pattern: string): boolean {
  return /(^|[^~])[*?]/.test(pattern);
}
