/**
 * Lookup, reference and dynamic-array functions.
 *
 * Lookups read their ranges through a `Grid` view instead of materialising
 * them: an exact match over A:A scans the used rows only, and only the cell
 * that is returned is read from the result column. Functions that Excel
 * defines as returning a reference (INDEX, OFFSET, INDIRECT, XLOOKUP, CHOOSE)
 * return a RangeRef when they can, so `A1:INDEX(A:A,5)` and `SUM(OFFSET(…))`
 * work.
 */

import { colToLetters, MAX_COLS, MAX_ROWS, quoteSheetName } from '../../address';
import {
  compareScalars,
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
import { broadcastAt, clippedExtent, evaluate, MAX_MATRIX_CELLS } from '../evaluator';
import { tokenize } from '../lexer';
import type { EvalContext, FunctionSpec, Thunk } from '../types';
import { bool, dims, hasWildcards, int, num, text, toMatrix, toScalar, wildcardRegExp } from './helpers';

// ---------------------------------------------------------------------------
// Range views
// ---------------------------------------------------------------------------

/** Rows and columns of a range worth reading, with toMatrix's clipping rule. */
function clippedSize(ref: RangeRef, ctx: EvalContext): { rows: number; cols: number } {
  const { rows, cols } = clippedExtent(ref, ctx);
  return { rows: Math.max(rows, 1), cols: Math.max(cols, 1) };
}

/** Read-only view of a range, array or scalar argument. */
interface Grid {
  /** Full size: a whole column has 1,048,576 rows. */
  rows: number;
  cols: number;
  /** The part worth scanning; past it a whole-column/row reference is blank. */
  scanRows: number;
  scanCols: number;
  ref: RangeRef | null;
  get(r: number, c: number): Scalar;
}

function gridOf(v: EvalValue, ctx: EvalContext): Grid | CellError {
  if (isError(v)) return v;
  if (isRange(v)) {
    const ref = v;
    const scan = clippedSize(ref, ctx);
    return {
      rows: ref.r2 - ref.r1 + 1,
      cols: ref.c2 - ref.c1 + 1,
      scanRows: scan.rows,
      scanCols: scan.cols,
      ref,
      get: (r, c) => ctx.host.cellValue(ref.sheetId, ref.r1 + r, ref.c1 + c),
    };
  }
  if (isMatrix(v)) {
    const m = v;
    return { rows: m.rows, cols: m.cols, scanRows: m.rows, scanCols: m.cols, ref: null, get: (r, c) => m.data[r]?.[c] ?? null };
  }
  const s = v;
  return { rows: 1, cols: 1, scanRows: 1, scanCols: 1, ref: null, get: () => s };
}

/** One row or column of a grid. */
interface Vec {
  /** Entries worth scanning. */
  length: number;
  /** Full length; entries from `length` on are blank. */
  total: number;
  get(i: number): Scalar;
}

const colVec = (g: Grid, c: number): Vec => ({ length: g.scanRows, total: g.rows, get: (i) => g.get(i, c) });
const rowVec = (g: Grid, r: number): Vec => ({ length: g.scanCols, total: g.cols, get: (i) => g.get(r, i) });

/** Sub-block of a grid: a reference when the grid is one, else an array (or a single value). */
function pick(g: Grid, r1: number, c1: number, r2: number, c2: number): EvalValue {
  if (g.ref) {
    const { sheetId } = g.ref;
    return { kind: 'range', sheetId, r1: g.ref.r1 + r1, c1: g.ref.c1 + c1, r2: g.ref.r1 + r2, c2: g.ref.c1 + c2 };
  }
  if (r1 === r2 && c1 === c2) return g.get(r1, c1);
  const data: Scalar[][] = [];
  for (let r = r1; r <= r2; r++) {
    const row: Scalar[] = [];
    for (let c = c1; c <= c2; c++) row.push(g.get(r, c));
    data.push(row);
  }
  return matrix(data);
}

/** An array result; an empty one is #CALC! as in Excel. */
function result(data: Scalar[][]): Matrix | Scalar {
  if (data.length === 0 || (data[0]?.length ?? 0) === 0) return ERR.calc;
  return matrix(data);
}

/** Optional argument that is absent or left empty (`F(a,,b)`). */
function omitted(v: EvalValue | undefined): v is undefined | null {
  return v === undefined || v === null;
}

/** Every value of an argument as numbers, row-major (CHOOSECOLS indices, SORT keys). */
function numberList(v: EvalValue, ctx: EvalContext): number[] | CellError {
  const m = toMatrix(v, ctx);
  if (isError(m)) return m;
  const out: number[] = [];
  for (const row of m.data) {
    for (const x of row) {
      const n = toNumber(x);
      if (isError(n)) return n;
      out.push(Math.trunc(n));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

type Kind = 'n' | 's' | 'b';

function kindOf(v: Scalar): Kind | null {
  switch (typeof v) {
    case 'number':
      return 'n';
    case 'string':
      return 's';
    case 'boolean':
      return 'b';
    default:
      return null;
  }
}

/**
 * Equality for exact lookups: same type only (1 never matches "1"), text
 * case-insensitively, with * ? ~ wildcards when `wildcards` is set. With
 * `blankMatches` a blank lookup value finds blank cells (XLOOKUP/XMATCH).
 */
function exactMatcher(x: Scalar, wildcards: boolean, blankMatches = false): (v: Scalar) => boolean {
  if (x === null) return blankMatches ? (v) => v === null || v === '' : (v) => v === 0;
  if (typeof x === 'string') {
    if (wildcards && (hasWildcards(x) || /~[*?~]/.test(x))) {
      const re = wildcardRegExp(x);
      return (v) => typeof v === 'string' && re.test(v);
    }
    const lower = x.toLowerCase();
    return (v) => typeof v === 'string' && v.toLowerCase() === lower;
  }
  return (v) => v === x;
}

/** First (or last) index whose value matches; blanks past the used area count. */
function linearFind(vec: Vec, match: (v: Scalar) => boolean, reverse: boolean): number {
  const blankTail = vec.total > vec.length && match(null);
  if (reverse) {
    if (blankTail) return vec.total - 1;
    for (let i = vec.length - 1; i >= 0; i--) if (match(vec.get(i))) return i;
    return -1;
  }
  for (let i = 0; i < vec.length; i++) if (match(vec.get(i))) return i;
  return blankTail ? vec.length : -1;
}

/**
 * Binary search over sorted data: the last index whose value is <= x
 * (ascending) or >= x (descending), or -1. Values of another type than x,
 * blanks and errors are stepped over, which is what makes the
 * `LOOKUP(2,1/(range=x),results)` idiom find the last match.
 */
function binarySearch(vec: Vec, x: Scalar, descending: boolean): number {
  const kind = kindOf(x);
  let lo = 0;
  let hi = vec.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    let m = mid;
    let v: Scalar = null;
    for (; m <= hi; m++) {
      v = vec.get(m);
      if (kindOf(v) === kind) break;
    }
    if (m > hi) {
      hi = mid - 1;
      continue;
    }
    const c = compareScalars(v, x);
    if (descending ? c >= 0 : c <= 0) {
      found = m;
      lo = m + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** First index after `from` holding a value of `kind`, or -1. */
function nextOfKind(vec: Vec, from: number, kind: Kind | null): number {
  for (let i = from + 1; i < vec.length; i++) if (kindOf(vec.get(i)) === kind) return i;
  return -1;
}

/** Lookup value of the classic functions: a blank lookup value acts as 0. */
function classicLookupValue(v: EvalValue, ctx: EvalContext): Scalar {
  const x = toScalar(v, ctx);
  return x === null ? 0 : x;
}

/**
 * XLOOKUP/XMATCH search. match_mode 0 exact, -1 exact or next smaller,
 * 1 exact or next larger, 2 wildcard; search_mode 1 first-to-last, -1
 * last-to-first, 2 / -2 binary over ascending / descending data.
 */
function xfind(vec: Vec, x: Scalar, mode: number, search: number): number | CellError {
  if (![0, -1, 1, 2].includes(mode) || ![1, -1, 2, -2].includes(search)) return ERR.value;
  const xv: Scalar = x === null ? 0 : x;
  const kind = kindOf(xv);
  if (search === 2 || search === -2) {
    if (mode === 2) return ERR.value;
    const desc = search === -2;
    const i = binarySearch(vec, xv, desc);
    if (i >= 0 && compareScalars(vec.get(i), xv) === 0) return i;
    if (mode === 0) return -1;
    // Ascending: i holds the next smaller value; descending: the next larger.
    if ((mode === -1) !== desc) return i;
    return nextOfKind(vec, i, kind);
  }
  const reverse = search === -1;
  const match = exactMatcher(x, mode === 2, true);
  if (mode === 0 || mode === 2) return linearFind(vec, match, reverse);
  let best = -1;
  let bestValue: Scalar = null;
  const n = vec.length;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const v = vec.get(i);
    if (match(v)) return i;
    if (kindOf(v) !== kind) continue;
    const c = compareScalars(v, xv);
    if (mode === -1 ? c < 0 : c > 0) {
      const better = best < 0 || (mode === -1 ? compareScalars(v, bestValue) > 0 : compareScalars(v, bestValue) < 0);
      if (better) {
        best = i;
        bestValue = v;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Classic lookups
// ---------------------------------------------------------------------------

function vhlookup(args: EvalValue[], ctx: EvalContext, horizontal: boolean): EvalValue {
  const x = classicLookupValue(args[0]!, ctx);
  if (isError(x)) return x;
  const g = gridOf(args[1]!, ctx);
  if (isError(g)) return g;
  const index = int(args[2]!, ctx);
  if (isError(index)) return index;
  // An empty range_lookup argument (VLOOKUP(x,t,2,)) means FALSE, as in Excel.
  const approx = args[3] === undefined ? true : bool(args[3], ctx);
  if (isError(approx)) return approx;
  if (index < 1) return ERR.value;
  if (index > (horizontal ? g.rows : g.cols)) return ERR.ref;
  const vec = horizontal ? rowVec(g, 0) : colVec(g, 0);
  const i = approx ? binarySearch(vec, x, false) : linearFind(vec, exactMatcher(x, true), false);
  if (i < 0) return ERR.na;
  return horizontal ? g.get(index - 1, i) : g.get(i, index - 1);
}

/** LOOKUP: always an approximate (binary) search. */
function lookup(args: EvalValue[], ctx: EvalContext): EvalValue {
  const x = classicLookupValue(args[0]!, ctx);
  if (isError(x)) return x;
  const look = gridOf(args[1]!, ctx);
  if (isError(look)) return look;
  if (args.length < 3) {
    // Array form: search the first row of a wide array, else the first column; return from the last.
    const wide = look.cols > look.rows;
    const i = binarySearch(wide ? rowVec(look, 0) : colVec(look, 0), x, false);
    if (i < 0) return ERR.na;
    return wide ? look.get(look.rows - 1, i) : look.get(i, look.cols - 1);
  }
  const res = gridOf(args[2]!, ctx);
  if (isError(res)) return res;
  const lookWide = look.rows === 1 && look.cols > 1;
  const i = binarySearch(lookWide ? rowVec(look, 0) : colVec(look, 0), x, false);
  if (i < 0) return ERR.na;
  if (res.ref) {
    // A result range follows its own orientation and, like Excel, extends past its end.
    const across = res.rows === 1 && (res.cols > 1 || lookWide);
    const r = res.ref.r1 + (across ? 0 : i);
    const c = res.ref.c1 + (across ? i : 0);
    if (r >= MAX_ROWS || c >= MAX_COLS) return ERR.na;
    return ctx.host.cellValue(res.ref.sheetId, r, c);
  }
  const across = res.rows === 1;
  if (i >= (across ? res.cols : res.rows)) return ERR.na;
  return across ? res.get(0, i) : res.get(i, 0);
}

function matchFn(args: EvalValue[], ctx: EvalContext): EvalValue {
  const x = classicLookupValue(args[0]!, ctx);
  if (isError(x)) return x;
  const g = gridOf(args[1]!, ctx);
  if (isError(g)) return g;
  // MATCH(x,range,) is an exact match: the empty argument is 0.
  const type = args[2] === undefined ? 1 : num(args[2], ctx);
  if (isError(type)) return type;
  if (g.rows > 1 && g.cols > 1) return ERR.na;
  const vec = g.cols === 1 ? colVec(g, 0) : rowVec(g, 0);
  const i = type === 0 ? linearFind(vec, exactMatcher(x, true), false) : binarySearch(vec, x, type < 0);
  return i < 0 ? ERR.na : i + 1;
}

function modes(args: EvalValue[], at: number, ctx: EvalContext): { mode: number; search: number } | CellError {
  const mode = omitted(args[at]) ? 0 : int(args[at]!, ctx);
  if (isError(mode)) return mode;
  const search = omitted(args[at + 1]) ? 1 : int(args[at + 1]!, ctx);
  if (isError(search)) return search;
  return { mode, search };
}

function xmatch(args: EvalValue[], ctx: EvalContext): EvalValue {
  const x = toScalar(args[0]!, ctx);
  if (isError(x)) return x;
  const g = gridOf(args[1]!, ctx);
  if (isError(g)) return g;
  const m = modes(args, 2, ctx);
  if (isError(m)) return m;
  if (g.rows > 1 && g.cols > 1) return ERR.value;
  const i = xfind(g.cols === 1 ? colVec(g, 0) : rowVec(g, 0), x, m.mode, m.search);
  if (isError(i)) return i;
  return i < 0 ? ERR.na : i + 1;
}

function xlookup(args: EvalValue[], ctx: EvalContext): EvalValue {
  const x = toScalar(args[0]!, ctx);
  if (isError(x)) return x;
  const look = gridOf(args[1]!, ctx);
  if (isError(look)) return look;
  const ret = gridOf(args[2]!, ctx);
  if (isError(ret)) return ret;
  const m = modes(args, 4, ctx);
  if (isError(m)) return m;
  if (look.rows > 1 && look.cols > 1) return ERR.value;
  let vertical: boolean;
  if (look.cols === 1 && ret.rows === look.rows) vertical = true;
  else if (look.rows === 1 && ret.cols === look.cols) vertical = false;
  else return ERR.value;
  const i = xfind(vertical ? colVec(look, 0) : rowVec(look, 0), x, m.mode, m.search);
  if (isError(i)) return i;
  if (i < 0) return omitted(args[3]) ? ERR.na : args[3];
  return vertical ? pick(ret, i, 0, i, ret.cols - 1) : pick(ret, 0, i, ret.rows - 1, i);
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** INDEX(array, row, [col], [area]): row/col 0 selects the whole column/row. */
function index(args: EvalValue[], ctx: EvalContext): EvalValue {
  const source = args[0]!;
  if (isError(source)) return source;
  if (!omitted(args[3])) {
    const area = int(args[3], ctx);
    if (isError(area)) return area;
    // One reference has one area; multi-area references are not supported by the parser.
    if (area !== 1) return ERR.ref;
  }
  const g = gridOf(source, ctx);
  if (isError(g)) return g;
  let row = omitted(args[1]) ? 0 : int(args[1], ctx);
  if (isError(row)) return row;
  let col: number;
  if (args.length < 3) {
    // INDEX(A1:E1, 3) counts along a single row; a 2-D array returns the whole row.
    if (g.rows === 1 && g.cols > 1) {
      col = row;
      row = 1;
    } else {
      col = g.cols === 1 ? 1 : 0;
    }
  } else {
    const c = omitted(args[2]) ? 0 : int(args[2], ctx);
    if (isError(c)) return c;
    col = c;
  }
  if (row < 0 || col < 0) return ERR.value;
  if (row > g.rows || col > g.cols) return ERR.ref;
  const r1 = row === 0 ? 0 : row - 1;
  const r2 = row === 0 ? g.rows - 1 : row - 1;
  const c1 = col === 0 ? 0 : col - 1;
  const c2 = col === 0 ? g.cols - 1 : col - 1;
  return pick(g, r1, c1, r2, c2);
}

/** CHOOSE: lazy, so only the chosen value is evaluated; an array index chooses per element. */
function choose(args: Thunk[], ctx: EvalContext): EvalValue {
  const iv = args[0]!();
  if (isError(iv)) return iv;
  const multi = (isRange(iv) && (iv.r1 !== iv.r2 || iv.c1 !== iv.c2)) || (isMatrix(iv) && (iv.rows > 1 || iv.cols > 1));
  if (!multi) {
    const n = num(iv, ctx);
    if (isError(n)) return n;
    const k = Math.trunc(n);
    if (k < 1 || k >= args.length) return ERR.value;
    return args[k]!();
  }
  const im = toMatrix(iv, ctx);
  if (isError(im)) return im;
  // Each choice is evaluated once; the result broadcasts the index against the chosen values,
  // so CHOOSE({1,2},B1:B9,A1:A9) builds a two-column table.
  const chosen = new Map<number, Matrix | CellError>();
  const valueFor = (k: number): Matrix | CellError => {
    let m = chosen.get(k);
    if (!m) {
      const v = args[k]!();
      m = isError(v) ? matrix([[v]]) : toMatrix(v, ctx);
      chosen.set(k, m);
    }
    return m;
  };
  const indexAt = (r: number, c: number): number | CellError => {
    const n = toNumber(broadcastAt(im, r, c));
    if (isError(n)) return n;
    const k = Math.trunc(n);
    return k < 1 || k >= args.length ? ERR.value : k;
  };
  let rows = im.rows;
  let cols = im.cols;
  for (let r = 0; r < im.rows; r++) {
    for (let c = 0; c < im.cols; c++) {
      const k = indexAt(r, c);
      if (isError(k)) continue;
      const m = valueFor(k);
      if (isError(m)) return m;
      rows = Math.max(rows, m.rows);
      cols = Math.max(cols, m.cols);
    }
  }
  const data: Scalar[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < cols; c++) {
      const k = indexAt(r, c);
      if (isError(k)) {
        row.push(k);
        continue;
      }
      const m = valueFor(k);
      row.push(isError(m) ? m : broadcastAt(m, r, c));
    }
    data.push(row);
  }
  return matrix(data);
}

/** OFFSET(ref, rows, cols, [height], [width]); a negative height/width extends up/left, as Excel allows. */
function offset(args: EvalValue[], ctx: EvalContext): EvalValue {
  const ref = args[0]!;
  if (isError(ref)) return ref;
  if (!isRange(ref)) return ERR.value;
  const dr = int(args[1]!, ctx);
  if (isError(dr)) return dr;
  const dc = int(args[2]!, ctx);
  if (isError(dc)) return dc;
  const h = omitted(args[3]) ? ref.r2 - ref.r1 + 1 : int(args[3], ctx);
  if (isError(h)) return h;
  const w = omitted(args[4]) ? ref.c2 - ref.c1 + 1 : int(args[4], ctx);
  if (isError(w)) return w;
  if (h === 0 || w === 0) return ERR.ref;
  const top = ref.r1 + dr;
  const left = ref.c1 + dc;
  const r1 = h > 0 ? top : top + h + 1;
  const r2 = h > 0 ? top + h - 1 : top;
  const c1 = w > 0 ? left : left + w + 1;
  const c2 = w > 0 ? left + w - 1 : left;
  if (r1 < 0 || c1 < 0 || r2 >= MAX_ROWS || c2 >= MAX_COLS) return ERR.ref;
  return { kind: 'range', sheetId: ref.sheetId, r1, c1, r2, c2 };
}

/** INDIRECT(text, [a1]): A1 text (sheet prefixes, ranges, whole rows/columns, defined names) or R1C1. */
function indirect(args: EvalValue[], ctx: EvalContext): EvalValue {
  const t = text(args[0]!, ctx);
  if (isError(t)) return t;
  const a1 = omitted(args[1]) ? true : bool(args[1], ctx);
  if (isError(a1)) return a1;
  const s = t.trim();
  if (s === '') return ERR.ref;
  return a1 ? indirectA1(s, ctx) : indirectR1C1(s, ctx);
}

function indirectA1(s: string, ctx: EvalContext): EvalValue {
  let tokens;
  try {
    tokens = tokenize(s).filter((tok) => tok.type !== 'ws');
  } catch {
    return ERR.ref;
  }
  const tok = tokens[0];
  if (tokens.length !== 1 || !tok) return ERR.ref;
  if (tok.type === 'ref') {
    const { ref } = tok;
    const sheetId = ref.sheet === null ? ctx.sheetId : ctx.host.sheetIdByName(ref.sheet);
    if (!sheetId) return ERR.ref;
    return { kind: 'range', sheetId, r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 };
  }
  if (tok.type === 'name') {
    // Through the evaluator so its recursion guard for names applies.
    const v = evaluate({ type: 'name', name: tok.value }, ctx);
    return isRange(v) ? v : ERR.ref;
  }
  return ERR.ref;
}

interface R1C1Part {
  kind: 'cell' | 'row' | 'col';
  r: number;
  c: number;
}

const R1C1_CELL = /^R(?:\[(-?\d+)\]|(\d+))?C(?:\[(-?\d+)\]|(\d+))?$/i;
const R1C1_ROW = /^R(?:\[(-?\d+)\]|(\d+))?$/i;
const R1C1_COL = /^C(?:\[(-?\d+)\]|(\d+))?$/i;

function r1c1Index(rel: string | undefined, abs: string | undefined, here: number): number {
  if (rel !== undefined) return here + Number(rel);
  if (abs !== undefined) return Number(abs) - 1;
  return here;
}

function r1c1Part(p: string, ctx: EvalContext): R1C1Part | null {
  let m = R1C1_CELL.exec(p);
  if (m) return { kind: 'cell', r: r1c1Index(m[1], m[2], ctx.row), c: r1c1Index(m[3], m[4], ctx.col) };
  m = R1C1_ROW.exec(p);
  if (m) return { kind: 'row', r: r1c1Index(m[1], m[2], ctx.row), c: 0 };
  m = R1C1_COL.exec(p);
  if (m) return { kind: 'col', r: 0, c: r1c1Index(m[1], m[2], ctx.col) };
  return null;
}

/** Splits an optional `Sheet!` / `'My sheet'!` prefix off reference text. */
function splitSheet(s: string): { sheet: string | null; body: string } | null {
  if (s.startsWith("'")) {
    let name = '';
    let i = 1;
    for (;;) {
      if (i >= s.length) return null;
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += s[i];
      i++;
    }
    if (s[i + 1] !== '!') return null;
    return { sheet: name, body: s.slice(i + 2) };
  }
  const bang = s.lastIndexOf('!');
  return bang < 0 ? { sheet: null, body: s } : { sheet: s.slice(0, bang), body: s.slice(bang + 1) };
}

function indirectR1C1(s: string, ctx: EvalContext): EvalValue {
  const split = splitSheet(s);
  if (!split) return ERR.ref;
  const sheetId = split.sheet === null ? ctx.sheetId : ctx.host.sheetIdByName(split.sheet);
  if (!sheetId) return ERR.ref;
  const parts = split.body.split(':');
  if (parts.length > 2) return ERR.ref;
  const a = r1c1Part(parts[0]!.trim(), ctx);
  const b = parts.length === 2 ? r1c1Part(parts[1]!.trim(), ctx) : a;
  if (!a || !b || a.kind !== b.kind) return ERR.ref;
  let r1 = Math.min(a.r, b.r);
  let r2 = Math.max(a.r, b.r);
  let c1 = Math.min(a.c, b.c);
  let c2 = Math.max(a.c, b.c);
  if (a.kind === 'row') {
    c1 = 0;
    c2 = MAX_COLS - 1;
  } else if (a.kind === 'col') {
    r1 = 0;
    r2 = MAX_ROWS - 1;
  }
  if (r1 < 0 || c1 < 0 || r2 >= MAX_ROWS || c2 >= MAX_COLS) return ERR.ref;
  return { kind: 'range', sheetId, r1, c1, r2, c2 };
}

/** ROW/COLUMN: a multi-row (multi-column) reference gives an array, clipped like toMatrix clips. */
function rowOrColumn(args: EvalValue[], ctx: EvalContext, isRow: boolean): EvalValue {
  if (args.length === 0 || args[0] === null) return (isRow ? ctx.row : ctx.col) + 1;
  const v = args[0]!;
  if (isError(v)) return v;
  if (!isRange(v)) return ERR.value;
  const size = clippedSize(v, ctx);
  const start = (isRow ? v.r1 : v.c1) + 1;
  const n = isRow ? size.rows : size.cols;
  if (n === 1) return start;
  if (isRow) {
    const data: Scalar[][] = new Array(n);
    for (let i = 0; i < n; i++) data[i] = [start + i];
    return matrix(data);
  }
  const row: Scalar[] = new Array(n);
  for (let i = 0; i < n; i++) row[i] = start + i;
  return matrix([row]);
}

function address(args: EvalValue[], ctx: EvalContext): EvalValue {
  const row = int(args[0]!, ctx);
  if (isError(row)) return row;
  const col = int(args[1]!, ctx);
  if (isError(col)) return col;
  const abs = omitted(args[2]) ? 1 : int(args[2], ctx);
  if (isError(abs)) return abs;
  const a1 = omitted(args[3]) ? true : bool(args[3], ctx);
  if (isError(a1)) return a1;
  if (row < 1 || col < 1 || row > MAX_ROWS || col > MAX_COLS || abs < 1 || abs > 4) return ERR.value;
  const absRow = abs === 1 || abs === 2;
  const absCol = abs === 1 || abs === 3;
  const body = a1
    ? `${absCol ? '$' : ''}${colToLetters(col - 1)}${absRow ? '$' : ''}${row}`
    : `R${absRow ? row : `[${row}]`}C${absCol ? col : `[${col}]`}`;
  if (omitted(args[4])) return body;
  const sheet = text(args[4], ctx);
  if (isError(sheet)) return sheet;
  return sheet === '' ? `!${body}` : `${quoteSheetName(sheet)}!${body}`;
}

// ---------------------------------------------------------------------------
// Dynamic arrays
// ---------------------------------------------------------------------------

function transpose(data: Scalar[][], rows: number, cols: number): Scalar[][] {
  const out: Scalar[][] = new Array(cols);
  for (let c = 0; c < cols; c++) {
    const row: Scalar[] = new Array(rows);
    for (let r = 0; r < rows; r++) row[r] = data[r]![c]!;
    out[c] = row;
  }
  return out;
}

/** Truthiness of a FILTER include value: text is #VALUE!, errors propagate. */
function includeFlag(v: Scalar): boolean | CellError {
  if (isError(v)) return v;
  if (typeof v === 'string') return ERR.value;
  if (typeof v === 'number') return v !== 0;
  return v === true;
}

function filter(args: EvalValue[], ctx: EvalContext): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  const inc = toMatrix(args[1]!, ctx);
  if (isError(inc)) return inc;
  const flags: boolean[] = [];
  let byRow: boolean;
  if (inc.cols === 1 && inc.rows === m.rows) byRow = true;
  else if (inc.rows === 1 && inc.cols === m.cols) byRow = false;
  else return ERR.value;
  const n = byRow ? m.rows : m.cols;
  for (let i = 0; i < n; i++) {
    const f = includeFlag(byRow ? inc.data[i]![0]! : inc.data[0]![i]!);
    if (isError(f)) return f;
    flags.push(f);
  }
  let data: Scalar[][];
  if (byRow) data = m.data.filter((_, i) => flags[i]);
  else data = m.data.map((row) => row.filter((_, i) => flags[i]));
  if (data.length === 0 || (data[0]?.length ?? 0) === 0) {
    return args.length > 2 ? args[2]! : { ...ERR.calc, message: 'FILTER returned no rows' };
  }
  return matrix(data);
}

/** Sort order of values: numbers, text, logicals, errors; blanks are handled by the caller. */
function sortRank(v: Scalar): number {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

function sortCompare(a: Scalar, b: Scalar, order: number): number {
  // Blanks go last whichever way the sort runs.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const ra = sortRank(a);
  const rb = sortRank(b);
  if (ra !== rb) return (ra - rb) * order;
  return compareScalars(a, b) * order;
}

/** Sorts the rows (or columns) of `m` by keys; `keyOf(line, k)` reads key k of a line. */
function sortLines(
  m: Matrix,
  byCol: boolean,
  keys: number,
  keyOf: (line: number, k: number) => Scalar,
  orders: number[],
): Matrix {
  const n = byCol ? m.cols : m.rows;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((x, y) => {
    for (let k = 0; k < keys; k++) {
      const c = sortCompare(keyOf(x, k), keyOf(y, k), orders[k]!);
      if (c !== 0) return c;
    }
    return x - y;
  });
  if (!byCol) return matrix(order.map((i) => m.data[i]!));
  return matrix(m.data.map((row) => order.map((i) => row[i]!)));
}

function sortFn(args: EvalValue[], ctx: EvalContext): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  const byCol = omitted(args[3]) ? false : bool(args[3], ctx);
  if (isError(byCol)) return byCol;
  const indices = omitted(args[1]) ? [1] : numberList(args[1], ctx);
  if (isError(indices)) return indices;
  let orders = omitted(args[2]) ? [1] : numberList(args[2], ctx);
  if (isError(orders)) return orders;
  if (orders.length === 1 && indices.length > 1) {
    const only = orders[0]!;
    orders = indices.map(() => only);
  }
  if (orders.length !== indices.length) return ERR.value;
  const width = byCol ? m.rows : m.cols;
  if (indices.some((i) => i < 1 || i > width) || orders.some((o) => o !== 1 && o !== -1)) return ERR.value;
  const keyOf = byCol
    ? (line: number, k: number) => m.data[indices[k]! - 1]![line]!
    : (line: number, k: number) => m.data[line]![indices[k]! - 1]!;
  return sortLines(m, byCol, indices.length, keyOf, orders);
}

function sortBy(args: EvalValue[], ctx: EvalContext): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  const keys: Matrix[] = [];
  const orders: number[] = [];
  let byCol: boolean | null = null;
  for (let i = 1; i < args.length; i += 2) {
    const by = toMatrix(args[i]!, ctx);
    if (isError(by)) return by;
    let col: boolean;
    if (by.cols === 1 && by.rows === m.rows) col = false;
    else if (by.rows === 1 && by.cols === m.cols) col = true;
    else return ERR.value;
    if (byCol !== null && byCol !== col) return ERR.value;
    byCol = col;
    const o = omitted(args[i + 1]) ? 1 : int(args[i + 1]!, ctx);
    if (isError(o)) return o;
    if (o !== 1 && o !== -1) return ERR.value;
    keys.push(by);
    orders.push(o);
  }
  const cols = byCol === true;
  const keyOf = (line: number, k: number): Scalar => {
    const by = keys[k]!;
    return cols ? by.data[0]![line]! : by.data[line]![0]!;
  };
  return sortLines(m, cols, keys.length, keyOf, orders);
}

/** Identity of a value for UNIQUE: type-tagged, text case-insensitive like Excel. */
function uniqueKey(v: Scalar): string {
  if (v === null) return 'e';
  if (typeof v === 'number') return `n${v}`;
  if (typeof v === 'string') return `s${v.toLowerCase()}`;
  if (typeof v === 'boolean') return `b${v}`;
  return `x${v.code}`;
}

function unique(args: EvalValue[], ctx: EvalContext): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  const byCol = omitted(args[1]) ? false : bool(args[1], ctx);
  if (isError(byCol)) return byCol;
  const once = omitted(args[2]) ? false : bool(args[2], ctx);
  if (isError(once)) return once;
  const lines = byCol ? transpose(m.data, m.rows, m.cols) : m.data;
  const counts = new Map<string, { first: number; count: number }>();
  lines.forEach((line, i) => {
    const key = line.map(uniqueKey).join('\u0000');
    const seen = counts.get(key);
    if (seen) seen.count++;
    else counts.set(key, { first: i, count: 1 });
  });
  const kept: Scalar[][] = [];
  for (const { first, count } of counts.values()) {
    if (!once || count === 1) kept.push(lines[first]!);
  }
  if (kept.length === 0) return ERR.calc;
  return matrix(byCol ? transpose(kept, kept.length, kept[0]!.length) : kept);
}

function sequence(args: EvalValue[], ctx: EvalContext): EvalValue {
  const read = (i: number): number | CellError => (omitted(args[i]) ? 1 : num(args[i]!, ctx));
  const rows = read(0);
  if (isError(rows)) return rows;
  const cols = read(1);
  if (isError(cols)) return cols;
  const start = read(2);
  if (isError(start)) return start;
  const step = read(3);
  if (isError(step)) return step;
  const r = Math.trunc(rows);
  const c = Math.trunc(cols);
  if (r < 0 || c < 0) return ERR.value;
  if (r === 0 || c === 0) return ERR.calc;
  if (r > MAX_ROWS || c > MAX_COLS || r * c > MAX_MATRIX_CELLS) return ERR.value;
  const data: Scalar[][] = new Array(r);
  for (let i = 0; i < r; i++) {
    const row: Scalar[] = new Array(c);
    for (let j = 0; j < c; j++) row[j] = start + (i * c + j) * step;
    data[i] = row;
  }
  return matrix(data);
}

function stack(args: EvalValue[], ctx: EvalContext, vertical: boolean): EvalValue {
  const parts: Matrix[] = [];
  for (const a of args) {
    const m = isError(a) ? matrix([[a]]) : toMatrix(a, ctx);
    if (isError(m)) return m;
    parts.push(vertical ? m : matrix(transpose(m.data, m.rows, m.cols)));
  }
  // Stack rows, padding short ones with #N/A as Excel does.
  const width = Math.max(...parts.map((p) => p.cols));
  const data: Scalar[][] = [];
  for (const p of parts) {
    for (const row of p.data) data.push(row.length < width ? [...row, ...new Array<Scalar>(width - row.length).fill(ERR.na)] : row);
  }
  return result(vertical ? data : transpose(data, data.length, width));
}

/** [start, end) of the lines TAKE keeps; `n` undefined keeps all. */
function takeSpan(n: number | undefined, size: number): [number, number] {
  if (n === undefined) return [0, size];
  return n > 0 ? [0, Math.min(n, size)] : [Math.max(0, size + n), size];
}

function dropSpan(n: number | undefined, size: number): [number, number] {
  if (n === undefined) return [0, size];
  return n >= 0 ? [Math.min(n, size), size] : [0, Math.max(0, size + n)];
}

function takeOrDrop(args: EvalValue[], ctx: EvalContext, take: boolean): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  const rows = omitted(args[1]) ? undefined : int(args[1], ctx);
  if (isError(rows)) return rows;
  const cols = omitted(args[2]) ? undefined : int(args[2], ctx);
  if (isError(cols)) return cols;
  if (take && (rows === 0 || cols === 0)) return ERR.calc;
  const span = take ? takeSpan : dropSpan;
  const [r1, r2] = span(rows, m.rows);
  const [c1, c2] = span(cols, m.cols);
  return result(m.data.slice(r1, r2).map((row) => row.slice(c1, c2)));
}

function chooseLines(args: EvalValue[], ctx: EvalContext, cols: boolean): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  const size = cols ? m.cols : m.rows;
  const picks: number[] = [];
  for (let i = 1; i < args.length; i++) {
    const list = numberList(args[i]!, ctx);
    if (isError(list)) return list;
    for (const k of list) {
      if (k === 0 || Math.abs(k) > size) return ERR.value;
      picks.push(k > 0 ? k - 1 : size + k);
    }
  }
  if (cols) return result(m.data.map((row) => picks.map((c) => row[c]!)));
  return result(picks.map((r) => m.data[r]!));
}

function toVector(args: EvalValue[], ctx: EvalContext, asRow: boolean): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  const ignore = omitted(args[1]) ? 0 : int(args[1], ctx);
  if (isError(ignore)) return ignore;
  const byCol = omitted(args[2]) ? false : bool(args[2], ctx);
  if (isError(byCol)) return byCol;
  if (ignore < 0 || ignore > 3) return ERR.value;
  const skipBlanks = ignore === 1 || ignore === 3;
  const skipErrors = ignore === 2 || ignore === 3;
  const out: Scalar[] = [];
  const visit = (v: Scalar) => {
    if (skipBlanks && v === null) return;
    if (skipErrors && isError(v)) return;
    out.push(v);
  };
  if (byCol) {
    for (let c = 0; c < m.cols; c++) for (let r = 0; r < m.rows; r++) visit(m.data[r]![c]!);
  } else {
    for (const row of m.data) for (const v of row) visit(v);
  }
  if (out.length === 0) return ERR.calc;
  return matrix(asRow ? [out] : out.map((v) => [v]));
}

function wrap(args: EvalValue[], ctx: EvalContext, byRows: boolean): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  if (m.rows > 1 && m.cols > 1) return ERR.value;
  const count = int(args[1]!, ctx);
  if (isError(count)) return count;
  if (count < 1) return ERR.num;
  const pad: Scalar = args[2] === undefined ? ERR.na : toScalar(args[2], ctx);
  const flat = m.data.flat();
  const lines = Math.ceil(flat.length / count);
  const data: Scalar[][] = [];
  for (let i = 0; i < lines; i++) {
    const line: Scalar[] = [];
    for (let j = 0; j < count; j++) {
      const k = i * count + j;
      line.push(k < flat.length ? flat[k]! : pad);
    }
    data.push(line);
  }
  return result(byRows ? data : transpose(data, lines, count));
}

function expand(args: EvalValue[], ctx: EvalContext): EvalValue {
  const m = toMatrix(args[0]!, ctx);
  if (isError(m)) return m;
  const rows = omitted(args[1]) ? m.rows : int(args[1], ctx);
  if (isError(rows)) return rows;
  const cols = omitted(args[2]) ? m.cols : int(args[2], ctx);
  if (isError(cols)) return cols;
  if (rows < m.rows || cols < m.cols) return ERR.value;
  if (rows > MAX_ROWS || cols > MAX_COLS || rows * cols > MAX_MATRIX_CELLS) return ERR.num;
  const pad: Scalar = args[3] === undefined ? ERR.na : toScalar(args[3], ctx);
  const data: Scalar[][] = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = r < m.rows && c < m.cols ? m.data[r]![c]! : pad;
    data[r] = row;
  }
  return matrix(data);
}

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

export const lookupFunctions: FunctionSpec[] = [
  { name: 'VLOOKUP', minArgs: 3, maxArgs: 4, scalarArgs: [0, 2, 3], impl: (a, ctx) => vhlookup(a, ctx, false) },
  { name: 'HLOOKUP', minArgs: 3, maxArgs: 4, scalarArgs: [0, 2, 3], impl: (a, ctx) => vhlookup(a, ctx, true) },
  { name: 'LOOKUP', minArgs: 2, maxArgs: 3, scalarArgs: [0], impl: lookup },
  { name: 'MATCH', minArgs: 2, maxArgs: 3, scalarArgs: [0, 2], impl: matchFn },
  { name: 'XMATCH', minArgs: 2, maxArgs: 4, scalarArgs: [0, 2, 3], impl: xmatch },
  { name: 'XLOOKUP', minArgs: 3, maxArgs: 6, scalarArgs: [0, 4, 5], impl: xlookup },
  { name: 'INDEX', minArgs: 2, maxArgs: 4, scalarArgs: [1, 2, 3], impl: index },
  { name: 'CHOOSE', minArgs: 2, maxArgs: 255, lazy: true, impl: choose },
  { name: 'OFFSET', minArgs: 3, maxArgs: 5, volatile: true, impl: offset },
  { name: 'INDIRECT', minArgs: 1, maxArgs: 2, volatile: true, scalarArgs: [0, 1], impl: indirect },
  { name: 'ROW', minArgs: 0, maxArgs: 1, impl: (a, ctx) => rowOrColumn(a, ctx, true) },
  { name: 'COLUMN', minArgs: 0, maxArgs: 1, impl: (a, ctx) => rowOrColumn(a, ctx, false) },
  {
    name: 'ROWS',
    minArgs: 1,
    maxArgs: 1,
    impl: ([v]) => (isError(v!) ? v! : dims(v!).rows),
  },
  {
    name: 'COLUMNS',
    minArgs: 1,
    maxArgs: 1,
    impl: ([v]) => (isError(v!) ? v! : dims(v!).cols),
  },
  { name: 'ADDRESS', minArgs: 2, maxArgs: 5, scalarArgs: 'all', impl: address },
  {
    name: 'AREAS',
    minArgs: 1,
    maxArgs: 1,
    impl: ([v]) => (isError(v!) ? v! : isRange(v!) ? 1 : ERR.value),
  },
  {
    name: 'TRANSPOSE',
    minArgs: 1,
    maxArgs: 1,
    impl: ([v], ctx) => {
      const m = toMatrix(v!, ctx);
      return isError(m) ? m : result(transpose(m.data, m.rows, m.cols));
    },
  },
  { name: 'FILTER', minArgs: 2, maxArgs: 3, impl: filter },
  { name: 'SORT', minArgs: 1, maxArgs: 4, impl: sortFn },
  { name: 'SORTBY', minArgs: 2, maxArgs: 253, impl: sortBy },
  { name: 'UNIQUE', minArgs: 1, maxArgs: 3, impl: unique },
  { name: 'SEQUENCE', minArgs: 1, maxArgs: 4, impl: sequence },
  { name: 'VSTACK', minArgs: 1, maxArgs: 254, impl: (a, ctx) => stack(a, ctx, true) },
  { name: 'HSTACK', minArgs: 1, maxArgs: 254, impl: (a, ctx) => stack(a, ctx, false) },
  { name: 'TAKE', minArgs: 2, maxArgs: 3, impl: (a, ctx) => takeOrDrop(a, ctx, true) },
  { name: 'DROP', minArgs: 2, maxArgs: 3, impl: (a, ctx) => takeOrDrop(a, ctx, false) },
  { name: 'CHOOSECOLS', minArgs: 2, maxArgs: 254, impl: (a, ctx) => chooseLines(a, ctx, true) },
  { name: 'CHOOSEROWS', minArgs: 2, maxArgs: 254, impl: (a, ctx) => chooseLines(a, ctx, false) },
  { name: 'TOCOL', minArgs: 1, maxArgs: 3, impl: (a, ctx) => toVector(a, ctx, false) },
  { name: 'TOROW', minArgs: 1, maxArgs: 3, impl: (a, ctx) => toVector(a, ctx, true) },
  { name: 'WRAPROWS', minArgs: 2, maxArgs: 3, impl: (a, ctx) => wrap(a, ctx, true) },
  { name: 'WRAPCOLS', minArgs: 2, maxArgs: 3, impl: (a, ctx) => wrap(a, ctx, false) },
  { name: 'EXPAND', minArgs: 2, maxArgs: 4, impl: expand },
];
