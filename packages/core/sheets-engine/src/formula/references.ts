/**
 * Reference rewriting on formula text: what happens to formulas when rows or
 * columns are inserted or deleted, when a sheet is renamed or removed, and
 * when a formula is copied to another cell.
 *
 * Works on the token stream and splices replacement text into the original,
 * so everything other than the affected references is left as the user typed
 * it.
 */

import { colToLetters, MAX_COLS, MAX_ROWS, quoteSheetName } from '../address';
import { tokenize, type RefToken } from './lexer';

export type Axis = 'row' | 'col';

/** Returns the replacement for a reference, `null` for #REF!, or `undefined` to keep it. */
type RefRewriter = (ref: RefToken) => RefToken | null | undefined;

export function rewriteRefs(formula: string, rewrite: RefRewriter): string {
  let tokens;
  try {
    tokens = tokenize(formula);
  } catch {
    return formula;
  }
  let out = '';
  let last = 0;
  let changed = false;
  for (const t of tokens) {
    if (t.type !== 'ref') continue;
    const next = rewrite(t.ref);
    if (next === undefined) continue;
    out += formula.slice(last, t.start) + (next === null ? '#REF!' : printRef(next));
    last = t.end;
    changed = true;
  }
  return changed ? out + formula.slice(last) : formula;
}

export function printRef(ref: RefToken): string {
  const prefix = ref.sheet === null ? '' : `${quoteSheetName(ref.sheet)}!`;
  const col = (c: number, abs: boolean) => `${abs ? '$' : ''}${colToLetters(c)}`;
  const row = (r: number, abs: boolean) => `${abs ? '$' : ''}${r + 1}`;
  switch (ref.kind) {
    case 'cell':
      return `${prefix}${col(ref.c1, ref.absC1)}${row(ref.r1, ref.absR1)}`;
    case 'range':
      return `${prefix}${col(ref.c1, ref.absC1)}${row(ref.r1, ref.absR1)}:${col(ref.c2, ref.absC2)}${row(ref.r2, ref.absR2)}`;
    case 'cols':
      return `${prefix}${col(ref.c1, ref.absC1)}:${col(ref.c2, ref.absC2)}`;
    case 'rows':
      return `${prefix}${row(ref.r1, ref.absR1)}:${row(ref.r2, ref.absR2)}`;
  }
}

function sameSheet(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Does this reference point into `sheetName`, given the formula lives on `hostSheet`? */
function targets(ref: RefToken, hostSheet: string, sheetName: string): boolean {
  return sameSheet(ref.sheet ?? hostSheet, sheetName);
}

export interface DimChange {
  /** Name of the sheet whose rows/columns change. */
  sheet: string;
  axis: Axis;
  at: number;
  count: number;
}

/** Rows/columns inserted before index `at`: references at or after it move along. */
export function adjustForInsert(formula: string, hostSheet: string, change: DimChange): string {
  return rewriteRefs(formula, (ref) => {
    if (!targets(ref, hostSheet, change.sheet)) return undefined;
    if (change.axis === 'row' && ref.kind === 'cols') return undefined;
    if (change.axis === 'col' && ref.kind === 'rows') return undefined;
    const [lo, hi, max] = change.axis === 'row' ? (['r1', 'r2', MAX_ROWS] as const) : (['c1', 'c2', MAX_COLS] as const);
    const a = ref[lo];
    const b = ref[hi];
    const na = a >= change.at ? a + change.count : a;
    let nb = b >= change.at ? b + change.count : b;
    if (na >= max) return null;
    if (nb >= max) {
      if (ref.kind === 'cell') return null;
      nb = max - 1;
    }
    if (na === a && nb === b) return undefined;
    return { ...ref, [lo]: na, [hi]: nb };
  });
}

/** Rows/columns [at, at+count) deleted. References into them become #REF!, ranges shrink. */
export function adjustForDelete(formula: string, hostSheet: string, change: DimChange): string {
  const end = change.at + change.count;
  return rewriteRefs(formula, (ref) => {
    if (!targets(ref, hostSheet, change.sheet)) return undefined;
    if (change.axis === 'row' && ref.kind === 'cols') return undefined;
    if (change.axis === 'col' && ref.kind === 'rows') return undefined;
    const [lo, hi] = change.axis === 'row' ? (['r1', 'r2'] as const) : (['c1', 'c2'] as const);
    const a = ref[lo];
    const b = ref[hi];
    const na = a < change.at ? a : a >= end ? a - change.count : change.at;
    const nb = b < change.at ? b : b >= end ? b - change.count : change.at - 1;
    if (na > nb) return null;
    if (ref.kind === 'cell' && a >= change.at && a < end) return null;
    if (na === a && nb === b) return undefined;
    return { ...ref, [lo]: na, [hi]: nb };
  });
}

/**
 * Rows/columns [from, from+count) moved so that they start at `to` (an index
 * in the sheet as it is *before* the move, Google-Sheets style: the block is
 * inserted before row `to`). References follow the moved cells.
 */
export function adjustForMove(
  formula: string,
  hostSheet: string,
  move: { sheet: string; axis: Axis; from: number; count: number; to: number },
): string {
  const map = moveIndexMapper(move.from, move.count, move.to);
  return rewriteRefs(formula, (ref) => {
    if (!targets(ref, hostSheet, move.sheet)) return undefined;
    if (move.axis === 'row' && ref.kind === 'cols') return undefined;
    if (move.axis === 'col' && ref.kind === 'rows') return undefined;
    const [lo, hi] = move.axis === 'row' ? (['r1', 'r2'] as const) : (['c1', 'c2'] as const);
    const a = ref[lo];
    const b = ref[hi];
    let na: number;
    let nb: number;
    if (a === b) {
      na = nb = map(a);
    } else {
      // A range keeps its endpoints' new positions (as Excel does).
      na = map(a);
      nb = map(b);
      if (na > nb) [na, nb] = [nb, na];
    }
    if (na === a && nb === b) return undefined;
    return { ...ref, [lo]: na, [hi]: nb };
  });
}

/** Index mapping for a block move; shared with the op layer. */
export function moveIndexMapper(from: number, count: number, to: number): (i: number) => number {
  const end = from + count;
  if (to >= from && to <= end) return (i) => i; // no-op move
  if (to < from) {
    return (i) => {
      if (i >= from && i < end) return to + (i - from);
      if (i >= to && i < from) return i + count;
      return i;
    };
  }
  return (i) => {
    if (i >= from && i < end) return to - count + (i - from);
    if (i >= end && i < to) return i - count;
    return i;
  };
}

export function renameSheetInFormula(formula: string, oldName: string, newName: string): string {
  return rewriteRefs(formula, (ref) => {
    if (ref.sheet === null || !sameSheet(ref.sheet, oldName)) return undefined;
    return { ...ref, sheet: newName };
  });
}

/** References to a removed sheet become #REF!. */
export function removeSheetFromFormula(formula: string, sheetName: string): string {
  return rewriteRefs(formula, (ref) => {
    if (ref.sheet === null || !sameSheet(ref.sheet, sheetName)) return undefined;
    return null;
  });
}

/**
 * The formula as it reads when copied `dRow` rows down and `dCol` columns
 * right: relative parts move, `$` parts stay. Off-sheet results become #REF!.
 */
export function translateFormula(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula;
  return rewriteRefs(formula, (ref) => {
    const next = { ...ref };
    if (ref.kind !== 'cols') {
      if (!ref.absR1) next.r1 += dRow;
      if (!ref.absR2) next.r2 += dRow;
    }
    if (ref.kind !== 'rows') {
      if (!ref.absC1) next.c1 += dCol;
      if (!ref.absC2) next.c2 += dCol;
    }
    if (next.r1 < 0 || next.c1 < 0 || next.r2 >= MAX_ROWS || next.c2 >= MAX_COLS) return null;
    if (next.r2 < 0 || next.c2 < 0) return null;
    if (next.r1 > next.r2) [next.r1, next.r2] = [next.r2, next.r1];
    if (next.c1 > next.c2) [next.c1, next.c2] = [next.c2, next.c1];
    if (next.r1 === ref.r1 && next.r2 === ref.r2 && next.c1 === ref.c1 && next.c2 === ref.c2) return undefined;
    return next;
  });
}

/** Every literal reference in a formula, for the dependency graph and highlighting. */
export function collectRefs(formula: string): RefToken[] {
  try {
    return tokenize(formula).flatMap((t) => (t.type === 'ref' ? [t.ref] : []));
  } catch {
    return [];
  }
}
