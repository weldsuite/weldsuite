/**
 * Sorting a range. The editor works out the new contents and sends them as
 * ordinary cell writes (setCells + setStyles), so a sort needs no op of its
 * own: it co-edits like a paste and undoes exactly.
 */

import { rangesIntersect, type Range } from '../address';
import type { Engine } from '../calc/engine';
import { translateFormula } from '../formula/references';
import { isError, type Scalar } from '../values';
import { normalize, type CellPatch, type Op } from './types';

export interface SortKey {
  col: number;
  descending?: boolean;
}

export type SortResult = { op: Op } | { error: 'merged' | 'nothing' };

/**
 * Rows of `range` (below its header row, with `header`) reordered by `keys`,
 * first key first. Blanks go last either way; otherwise numbers come before
 * text, text before TRUE/FALSE, those before errors (reversed when
 * descending), and equal rows keep their order. Formulas move like copied
 * formulas, and each cell's own formatting moves with it. Ranges with merged
 * cells are not sorted.
 */
export function sortRangeOp(engine: Engine, sheetId: string, range: Range, keys: SortKey[], options: { header?: boolean } = {}): SortResult {
  const sheet = engine.workbook.requireSheet(sheetId);
  const used = engine.usedRange(sheetId);
  const first = range.r1 + (options.header ? 1 : 0);
  // Rows past the last filled one are blank and stay where they are.
  const last = Math.min(range.r2, sheet.rowCount - 1, used?.r2 ?? -1);
  const c2 = Math.min(range.c2, sheet.colCount - 1);
  if (keys.length === 0 || first >= last) return { error: 'nothing' };
  const body = { r1: first, c1: range.c1, r2: last, c2 };
  if (sheet.merges.some((m) => rangesIntersect(m, body))) return { error: 'merged' };

  const rows = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const keyValues = new Map(rows.map((row) => [row, keys.map((k) => engine.cellValue(sheetId, row, k.col))]));
  const order = [...rows].sort((a, b) => {
    const va = keyValues.get(a)!;
    const vb = keyValues.get(b)!;
    for (let i = 0; i < keys.length; i++) {
      const c = compareForSort(va[i]!, vb[i]!, !!keys[i]!.descending);
      if (c !== 0) return c;
    }
    return a - b;
  });

  const cells: CellPatch[] = [];
  const styles: [number, number, string | null][] = [];
  order.forEach((from, i) => {
    const to = rows[i]!;
    if (from === to) return;
    for (let col = range.c1; col <= c2; col++) {
      const source = sheet.cells.get(from, col);
      const target = sheet.cells.get(to, col);
      let content: CellPatch[2] = null;
      if (source?.f !== undefined) content = { f: translateFormula(source.f, to - from, 0) };
      else if (source && source.v !== null) content = { v: source.v };
      cells.push([to, col, content]);
      if ((source?.s ?? null) !== (target?.s ?? null)) styles.push([to, col, source?.s ?? null]);
    }
  });
  if (cells.length === 0) return { error: 'nothing' };
  return { op: normalize({ type: 'batch', ops: [{ type: 'setCells', sheetId, cells }, { type: 'setStyles', sheetId, cells: styles }] }) };
}

/** Blanks last in both directions; otherwise numbers < text < booleans < errors, reversed when descending. */
export function compareForSort(a: Scalar, b: Scalar, descending: boolean): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra === BLANK || rb === BLANK) return ra - rb;
  const c = ra === rb ? sameRank(a, b) : ra - rb;
  return descending ? -c : c;
}

const BLANK = 4;

function rank(v: Scalar): number {
  if (v === null || v === '') return BLANK;
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

function sameRank(a: Scalar, b: Scalar): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { sensitivity: 'base' });
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (isError(a) && isError(b)) return a.code < b.code ? -1 : Number(a.code > b.code);
  return 0;
}
