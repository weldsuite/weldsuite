/**
 * Logical functions. IF, IFS, IFERROR, IFNA and SWITCH are lazy so only the
 * chosen branch is evaluated; when the tested value is an array they switch
 * to element-wise mode (=IF(A1:A3>1,"y","n") is a 3×1 array), evaluating a
 * branch only if some element needs it. AND, OR and XOR are eager, as in Excel.
 */

import {
  compareScalars,
  ERR,
  isError,
  isMatrix,
  isRange,
  toBoolean,
  type CellError,
  type EvalValue,
  type Matrix,
  type Scalar,
} from '../../values';
import { broadcastAt } from '../evaluator';
import type { EvalContext, FunctionSpec, Thunk } from '../types';
import { toMatrix, toScalar, visitArgs } from './helpers';

/** A value the way operators see it: a 1×1 range or array unwraps to its scalar. */
function arrayOrScalar(v: EvalValue, ctx: EvalContext): Matrix | Scalar {
  if (isRange(v)) {
    if (v.r1 === v.r2 && v.c1 === v.c2) return ctx.host.cellValue(v.sheetId, v.r1, v.c1);
    return toMatrix(v, ctx);
  }
  if (isMatrix(v)) return v.rows === 1 && v.cols === 1 ? v.data[0]![0]! : v;
  return v;
}

/** Element (r, c) of an array (broadcast) or a scalar; blanks read as 0 like Excel's branch results. */
function at(v: Matrix | Scalar, r: number, c: number): Scalar {
  const x = isMatrix(v) ? broadcastAt(v, r, c) : v;
  return x === null ? 0 : x;
}

function build(rows: number, cols: number, fn: (r: number, c: number) => Scalar): Matrix {
  const data: Scalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < cols; c++) row.push(fn(r, c));
    data.push(row);
  }
  return { kind: 'matrix', rows, cols, data };
}

/** Evaluates a branch argument; an empty one (IF(A1,,2)) is 0 and an omitted one is `missing`. */
function branch(t: Thunk | undefined, missing: Scalar): EvalValue {
  if (!t) return missing;
  const v = t();
  return v === null ? 0 : v;
}

function truth(v: Scalar): boolean | CellError {
  return isError(v) ? v : toBoolean(v);
}

/** Lazily evaluated, memoised branch values for the element-wise modes. */
function memo<T>(fn: (i: number) => T): (i: number) => T {
  const cache = new Map<number, T>();
  return (i) => {
    if (!cache.has(i)) cache.set(i, fn(i));
    return cache.get(i)!;
  };
}

function errorTrap(name: string, catches: (e: CellError) => boolean): FunctionSpec {
  return {
    name,
    minArgs: 2,
    maxArgs: 2,
    lazy: true,
    impl(args, ctx) {
      const raw = args[0]!();
      const v = arrayOrScalar(raw, ctx);
      const fallback = memo(() => arrayOrScalar(branch(args[1], 0), ctx));
      if (!isMatrix(v)) {
        if (isError(v) && catches(v)) return branch(args[1], 0);
        return raw === null ? 0 : raw;
      }
      return build(v.rows, v.cols, (r, c) => {
        const x = v.data[r]![c]!;
        if (isError(x) && catches(x)) return at(fallback(0), r, c);
        return x === null ? 0 : x;
      });
    },
  };
}

/** Logical values for AND/OR/XOR: text in ranges is skipped, typed text must read TRUE/FALSE. */
function logicals(args: EvalValue[], ctx: EvalContext): boolean[] | CellError {
  const out: boolean[] = [];
  let error = null as CellError | null;
  visitArgs(args, ctx, (v, direct) => {
    if (isError(v)) {
      error = v;
      return false;
    }
    if (typeof v === 'boolean') out.push(v);
    else if (typeof v === 'number') out.push(v !== 0);
    else if (direct) {
      const b = toBoolean(v);
      if (isError(b)) {
        error = b;
        return false;
      }
      out.push(b);
    }
  });
  if (error) return error;
  return out.length ? out : ERR.value;
}

function logicalFn(name: string, combine: (xs: boolean[]) => boolean): FunctionSpec {
  return {
    name,
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      const xs = logicals(args, ctx);
      return isError(xs) ? xs : combine(xs);
    },
  };
}

export const logicalFunctions: FunctionSpec[] = [
  {
    name: 'IF',
    minArgs: 2,
    maxArgs: 3,
    lazy: true,
    impl(args, ctx) {
      const cond = arrayOrScalar(args[0]!(), ctx);
      if (!isMatrix(cond)) {
        const b = truth(cond);
        if (isError(b)) return b;
        return branch(b ? args[1] : args[2], false);
      }
      const picks: Matrix = { ...cond, data: cond.data.map((row) => row.map(truth)) };
      const flat = picks.data.flat();
      const whenTrue = flat.includes(true) ? arrayOrScalar(branch(args[1], false), ctx) : null;
      const whenFalse = flat.includes(false) ? arrayOrScalar(branch(args[2], false), ctx) : null;
      let rows = cond.rows;
      let cols = cond.cols;
      for (const b of [whenTrue, whenFalse]) {
        if (isMatrix(b)) {
          rows = Math.max(rows, b.rows);
          cols = Math.max(cols, b.cols);
        }
      }
      return build(rows, cols, (r, c) => {
        const p = broadcastAt(picks, r, c);
        if (isError(p)) return p;
        return at(p ? whenTrue : whenFalse, r, c);
      });
    },
  },
  {
    name: 'IFS',
    minArgs: 2,
    maxArgs: 254,
    lazy: true,
    impl(args, ctx) {
      if (args.length % 2) return { ...ERR.na, message: 'IFS takes condition, value pairs' };
      for (let i = 0; i < args.length; i += 2) {
        const cond = arrayOrScalar(args[i]!(), ctx);
        if (!isMatrix(cond)) {
          const b = truth(cond);
          if (isError(b)) return b;
          if (b) return branch(args[i + 1], 0);
          continue;
        }
        // Element-wise from here: every remaining condition is evaluated.
        const conds: Array<Matrix | Scalar> = [cond];
        for (let j = i + 2; j < args.length; j += 2) conds.push(arrayOrScalar(args[j]!(), ctx));
        const value = memo((k) => arrayOrScalar(branch(args[i + 2 * k + 1], 0), ctx));
        let rows = 1;
        let cols = 1;
        for (const m of conds) {
          if (isMatrix(m)) {
            rows = Math.max(rows, m.rows);
            cols = Math.max(cols, m.cols);
          }
        }
        return build(rows, cols, (r, c) => {
          for (let k = 0; k < conds.length; k++) {
            const m = conds[k]!;
            const b = truth(isMatrix(m) ? broadcastAt(m, r, c) : m);
            if (isError(b)) return b;
            if (b) return at(value(k), r, c);
          }
          return ERR.na;
        });
      }
      return ERR.na;
    },
  },
  errorTrap('IFERROR', () => true),
  errorTrap('IFNA', (e) => e.code === '#N/A'),
  {
    /** Exact match by value: text compares case-insensitively, "1" never equals 1. */
    name: 'SWITCH',
    minArgs: 3,
    maxArgs: 254,
    lazy: true,
    impl(args, ctx) {
      const pairs = Math.floor((args.length - 1) / 2);
      const hasDefault = (args.length - 1) % 2 === 1;
      const subject = arrayOrScalar(args[0]!(), ctx);
      const candidate = memo((i) => toScalar(args[1 + 2 * i]!(), ctx));
      const match = (s: Scalar): number | CellError => {
        if (isError(s)) return s;
        for (let i = 0; i < pairs; i++) {
          const v = candidate(i);
          if (isError(v)) return v;
          if (compareScalars(s, v) === 0) return i;
        }
        return -1;
      };
      if (!isMatrix(subject)) {
        const i = match(subject);
        if (isError(i)) return i;
        if (i >= 0) return branch(args[2 + 2 * i], 0);
        return hasDefault ? branch(args[args.length - 1], 0) : ERR.na;
      }
      const result = memo((i) => arrayOrScalar(branch(args[2 + 2 * i], 0), ctx));
      const fallback = memo(() => arrayOrScalar(branch(args[args.length - 1], 0), ctx));
      return build(subject.rows, subject.cols, (r, c) => {
        const i = match(subject.data[r]![c]!);
        if (isError(i)) return i;
        if (i >= 0) return at(result(i), r, c);
        return hasDefault ? at(fallback(0), r, c) : ERR.na;
      });
    },
  },
  logicalFn('AND', (xs) => xs.every(Boolean)),
  logicalFn('OR', (xs) => xs.some(Boolean)),
  logicalFn('XOR', (xs) => xs.filter(Boolean).length % 2 === 1),
  {
    name: 'NOT',
    minArgs: 1,
    maxArgs: 1,
    scalarArgs: 'all',
    impl(args, ctx) {
      const b = truth(toScalar(args[0]!, ctx));
      return isError(b) ? b : !b;
    },
  },
  { name: 'TRUE', minArgs: 0, maxArgs: 0, impl: () => true },
  { name: 'FALSE', minArgs: 0, maxArgs: 0, impl: () => false },
];
