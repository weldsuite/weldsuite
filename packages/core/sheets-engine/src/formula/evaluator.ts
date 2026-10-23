/**
 * Formula evaluation over the AST.
 *
 * Sub-expressions evaluate to an EvalValue: a scalar, a RangeRef (kept as a
 * reference so functions such as ROW, OFFSET and INDEX can see the address)
 * or a Matrix. Operators and scalar function arguments lift over arrays the
 * way Excel's dynamic arrays do, so =A1:A3*2 yields a 3×1 array that the
 * engine spills.
 */

import { MAX_COLS, MAX_ROWS } from '../address';
import {
  compareScalars,
  ERR,
  isError,
  isMatrix,
  isRange,
  toNumber,
  toText,
  type CellError,
  type EvalValue,
  type Matrix,
  type RangeRef,
  type Scalar,
} from '../values';
import { getFunction } from './functions/registry';
import { parseFormula, type AstNode, type BinaryOp } from './parser';
import type { EagerFunctionSpec, EvalContext } from './types';

/** Largest array the evaluator will materialise from a range (cells). */
export const MAX_MATRIX_CELLS = 5_000_000;

export function evaluate(node: AstNode, ctx: EvalContext): EvalValue {
  switch (node.type) {
    case 'number':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'error':
      return ERR[errorKey(node.code)];
    case 'empty':
      return null;
    case 'ref': {
      const ref = node.ref;
      const sheetId = ref.sheet === null ? ctx.sheetId : ctx.host.sheetIdByName(ref.sheet);
      if (!sheetId) return ERR.ref;
      return { kind: 'range', sheetId, r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 };
    }
    case 'name':
      return evaluateName(node.name, ctx);
    case 'array':
      return {
        kind: 'matrix',
        rows: node.rows.length,
        cols: node.rows[0]?.length ?? 0,
        data: node.rows.map((row) => row.map((cell) => toScalar(evaluate(cell, ctx), ctx))),
      };
    case 'unary': {
      const v = evaluate(node.arg, ctx);
      return lift1(v, ctx, (x) => {
        const n = toNumber(x);
        if (isError(n)) return n;
        return node.op === '-' ? -n : n;
      });
    }
    case 'percent':
      return lift1(evaluate(node.arg, ctx), ctx, (x) => {
        const n = toNumber(x);
        return isError(n) ? n : n / 100;
      });
    case 'binary':
      return evaluateBinary(node.op, node.left, node.right, ctx);
    case 'call':
      return callFunction(node.name, node.args, ctx);
  }
}

function errorKey(code: CellError['code']): keyof typeof ERR {
  switch (code) {
    case '#NULL!':
      return 'null';
    case '#DIV/0!':
      return 'div0';
    case '#VALUE!':
      return 'value';
    case '#REF!':
      return 'ref';
    case '#NAME?':
      return 'name';
    case '#NUM!':
      return 'num';
    case '#N/A':
      return 'na';
    case '#SPILL!':
      return 'spill';
    case '#CALC!':
      return 'calc';
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const nameAstCache = new Map<string, AstNode | null>();
let nameDepth = 0;

function evaluateName(name: string, ctx: EvalContext): EvalValue {
  const formula = ctx.host.definedName(name, ctx.sheetId);
  if (formula === undefined) return { ...ERR.name, message: `Unknown name ${name}` };
  let ast = nameAstCache.get(formula);
  if (ast === undefined) {
    try {
      ast = parseFormula(formula);
    } catch {
      ast = null;
    }
    nameAstCache.set(formula, ast);
  }
  if (!ast) return ERR.name;
  if (nameDepth > 32) return ERR.ref;
  nameDepth++;
  try {
    return evaluate(ast, ctx);
  } finally {
    nameDepth--;
  }
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

function callFunction(name: string, argNodes: AstNode[], ctx: EvalContext): EvalValue {
  const spec = getFunction(name);
  if (!spec) return { ...ERR.name, message: `Unknown function ${name}` };
  if (argNodes.length < spec.minArgs || argNodes.length > spec.maxArgs) {
    return { ...ERR.na, message: `Wrong number of arguments to ${name}` };
  }
  if (spec.lazy) {
    return spec.impl(
      argNodes.map((n) => () => evaluate(n, ctx)),
      ctx,
    );
  }
  const args = argNodes.map((n) => evaluate(n, ctx));
  if (!spec.scalarArgs) return spec.impl(args, ctx);

  const scalarPositions =
    spec.scalarArgs === 'all' ? args.map((_, i) => i) : spec.scalarArgs.filter((i) => i < args.length);
  const arrays = arrayArgs(args, scalarPositions, ctx);
  if (isError(arrays)) return arrays;
  if (arrays.size === 0) {
    for (const i of scalarPositions) args[i] = toScalar(args[i]!, ctx);
    return spec.impl(args, ctx);
  }
  return liftCall(spec, args, scalarPositions, arrays, ctx);
}

/**
 * The scalar arguments that are multi-cell ranges or arrays, by position, as
 * arrays: these make the call lift. An error reading a range is returned.
 */
function arrayArgs(args: EvalValue[], positions: number[], ctx: EvalContext): Map<number, Matrix> | CellError {
  const arrays = new Map<number, Matrix>();
  for (const i of positions) {
    const a = args[i]!;
    if (isRange(a) && (a.r1 !== a.r2 || a.c1 !== a.c2)) {
      const m = toMatrix(a, ctx);
      if (isError(m)) return m;
      arrays.set(i, m);
    } else if (isMatrix(a) && (a.rows !== 1 || a.cols !== 1)) {
      arrays.set(i, a);
    }
  }
  return arrays;
}

/** Calls `spec` element-wise over the broadcast shape of `arrays`, other scalar arguments as single values. */
function liftCall(
  spec: EagerFunctionSpec,
  args: EvalValue[],
  positions: number[],
  arrays: Map<number, Matrix>,
  ctx: EvalContext,
): Matrix {
  let rows = 1;
  let cols = 1;
  for (const m of arrays.values()) {
    rows = Math.max(rows, m.rows);
    cols = Math.max(cols, m.cols);
  }
  const data: Scalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < cols; c++) {
      const callArgs = args.slice();
      for (const i of positions) {
        const m = arrays.get(i);
        callArgs[i] = m ? broadcastAt(m, r, c) : toScalar(args[i]!, ctx);
      }
      row.push(toScalar(spec.impl(callArgs, ctx), ctx));
    }
    data.push(row);
  }
  return { kind: 'matrix', rows, cols, data };
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

function evaluateBinary(op: BinaryOp, leftNode: AstNode, rightNode: AstNode, ctx: EvalContext): EvalValue {
  const left = evaluate(leftNode, ctx);
  const right = evaluate(rightNode, ctx);
  if (op === ':') return rangeUnion(left, right);
  return lift2(left, right, ctx, (a, b) => binaryScalar(op, a, b));
}

function rangeUnion(a: EvalValue, b: EvalValue): EvalValue {
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (!isRange(a) || !isRange(b) || a.sheetId !== b.sheetId) return ERR.value;
  return {
    kind: 'range',
    sheetId: a.sheetId,
    r1: Math.min(a.r1, b.r1),
    c1: Math.min(a.c1, b.c1),
    r2: Math.max(a.r2, b.r2),
    c2: Math.max(a.c2, b.c2),
  };
}

export function binaryScalar(op: Exclude<BinaryOp, ':'>, a: Scalar, b: Scalar): Scalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  switch (op) {
    case '&': {
      const sa = toText(a);
      if (isError(sa)) return sa;
      const sb = toText(b);
      if (isError(sb)) return sb;
      return sa + sb;
    }
    case '=':
      return compareScalars(a, b) === 0;
    case '<>':
      return compareScalars(a, b) !== 0;
    case '<':
      return compareScalars(a, b) < 0;
    case '>':
      return compareScalars(a, b) > 0;
    case '<=':
      return compareScalars(a, b) <= 0;
    case '>=':
      return compareScalars(a, b) >= 0;
    default:
      return arithmetic(op, a, b);
  }
}

/** + - * / ^ after coercing both sides to numbers; a non-finite result is #NUM!. */
function arithmetic(op: '+' | '-' | '*' | '/' | '^', a: Scalar, b: Scalar): Scalar {
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;
  let r: number;
  switch (op) {
    case '+':
      r = x + y;
      break;
    case '-':
      r = x - y;
      break;
    case '*':
      r = x * y;
      break;
    case '/':
      if (y === 0) return ERR.div0;
      r = x / y;
      break;
    case '^':
      if (x === 0 && y === 0) return ERR.num;
      if (x === 0 && y < 0) return ERR.div0;
      r = Math.pow(x, y);
      break;
  }
  return Number.isFinite(r) ? r : ERR.num;
}

// ---------------------------------------------------------------------------
// Value helpers shared with the function library
// ---------------------------------------------------------------------------

/**
 * A single value from anything: 1×1 ranges and arrays unwrap; a larger range
 * uses implicit intersection with the formula's row or column; a larger
 * array gives its top-left value.
 */
export function toScalar(v: EvalValue, ctx: EvalContext): Scalar {
  if (isRange(v)) {
    if (v.r1 === v.r2 && v.c1 === v.c2) return ctx.host.cellValue(v.sheetId, v.r1, v.c1);
    if (v.sheetId === ctx.sheetId) {
      if (v.c1 === v.c2 && ctx.row >= v.r1 && ctx.row <= v.r2) return ctx.host.cellValue(v.sheetId, ctx.row, v.c1);
      if (v.r1 === v.r2 && ctx.col >= v.c1 && ctx.col <= v.c2) return ctx.host.cellValue(v.sheetId, v.r1, ctx.col);
    }
    return ERR.value;
  }
  if (isMatrix(v)) return v.data[0]?.[0] ?? null;
  return v;
}

/**
 * Materialises a range as an array. Whole-column and whole-row references
 * are clipped to the sheet's used area, so A:A over 200 filled rows is a
 * 200×1 array, not a million blanks.
 */
export function toMatrix(v: EvalValue, ctx: EvalContext, clip = true): Matrix | CellError {
  if (isMatrix(v)) return v;
  if (isError(v)) return v;
  if (!isRange(v)) return { kind: 'matrix', rows: 1, cols: 1, data: [[v]] };
  const { r1, c1 } = v;
  let { r2, c2 } = v;
  if (clip && isClippable(v)) {
    const used = clippedExtent(v, ctx);
    if (used.rows === 0 || used.cols === 0) return { kind: 'matrix', rows: 1, cols: 1, data: [[null]] };
    r2 = r1 + used.rows - 1;
    c2 = c1 + used.cols - 1;
  }
  const rows = r2 - r1 + 1;
  const cols = c2 - c1 + 1;
  if (rows * cols > MAX_MATRIX_CELLS) return { ...ERR.calc, message: 'Range too large' };
  const data: Scalar[][] = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = ctx.host.cellValue(v.sheetId, r1 + r, c1 + c);
    data[r] = row;
  }
  return { kind: 'matrix', rows, cols, data };
}

/** Ranges this big (or whole rows/columns) are read only as far as the sheet's used area. */
export const CLIP_THRESHOLD_CELLS = 100_000;

export function isClippable(r: RangeRef): boolean {
  const rows = r.r2 - r.r1 + 1;
  const cols = r.c2 - r.c1 + 1;
  return rows === MAX_ROWS || cols === MAX_COLS || rows * cols > CLIP_THRESHOLD_CELLS;
}

/**
 * The part of a range that can hold values: the whole range when it is small,
 * otherwise cut at the used area (0×0 when nothing is filled past r1/c1).
 */
export function clippedExtent(r: RangeRef, ctx: EvalContext): { rows: number; cols: number } {
  const rows = r.r2 - r.r1 + 1;
  const cols = r.c2 - r.c1 + 1;
  if (!isClippable(r)) return { rows, cols };
  const used = ctx.host.usedRange(r.sheetId);
  if (!used) return { rows: 0, cols: 0 };
  return {
    rows: Math.max(0, Math.min(rows, used.r2 - r.r1 + 1)),
    cols: Math.max(0, Math.min(cols, used.c2 - r.c1 + 1)),
  };
}

/** Element (r, c) of an array broadcast to a larger shape; out of range is #N/A. */
export function broadcastAt(m: Matrix, r: number, c: number): Scalar {
  const rr = m.rows === 1 ? 0 : r;
  const cc = m.cols === 1 ? 0 : c;
  if (rr >= m.rows || cc >= m.cols) return ERR.na;
  return m.data[rr]![cc]!;
}

function asArray(v: EvalValue, ctx: EvalContext): Matrix | Scalar {
  if (isRange(v)) {
    if (v.r1 === v.r2 && v.c1 === v.c2) return ctx.host.cellValue(v.sheetId, v.r1, v.c1);
    return toMatrix(v, ctx);
  }
  if (isMatrix(v) && v.rows === 1 && v.cols === 1) return v.data[0]![0]!;
  return v;
}

export function lift1(v: EvalValue, ctx: EvalContext, fn: (x: Scalar) => Scalar): EvalValue {
  const a = asArray(v, ctx);
  if (!isMatrix(a)) return fn(a);
  return { kind: 'matrix', rows: a.rows, cols: a.cols, data: a.data.map((row) => row.map(fn)) };
}

export function lift2(
  left: EvalValue,
  right: EvalValue,
  ctx: EvalContext,
  fn: (a: Scalar, b: Scalar) => Scalar,
): EvalValue {
  const a = asArray(left, ctx);
  const b = asArray(right, ctx);
  if (!isMatrix(a) && !isMatrix(b)) return fn(a, b);
  const ma = isMatrix(a) ? a : null;
  const mb = isMatrix(b) ? b : null;
  const rows = Math.max(ma?.rows ?? 1, mb?.rows ?? 1);
  const cols = Math.max(ma?.cols ?? 1, mb?.cols ?? 1);
  const data: Scalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < cols; c++) {
      const x = ma ? broadcastAt(ma, r, c) : (a as Scalar);
      const y = mb ? broadcastAt(mb, r, c) : (b as Scalar);
      row.push(fn(x, y));
    }
    data.push(row);
  }
  return { kind: 'matrix', rows, cols, data };
}

/** Final value of a formula: references are dereferenced, a 1×1 array unwraps. */
export function resolveResult(v: EvalValue, ctx: EvalContext): Scalar | Matrix {
  if (isRange(v)) {
    if (v.r1 === v.r2 && v.c1 === v.c2) return ctx.host.cellValue(v.sheetId, v.r1, v.c1);
    return toMatrix(v, ctx);
  }
  if (isMatrix(v)) {
    if (v.rows === 1 && v.cols === 1) return v.data[0]![0]!;
    if (v.rows === 0 || v.cols === 0) return ERR.calc;
    return v;
  }
  return v;
}
