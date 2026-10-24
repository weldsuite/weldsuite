import { MAX_COLS, MAX_ROWS, normalizeRange, type Range } from '@weldsuite/sheets-engine';

export interface CellPos {
  row: number;
  col: number;
}

/**
 * The selection on one sheet: one or more ranges (ctrl+click adds one), an
 * active cell inside the last range, and the anchor that shift-extends from.
 */
export interface Selection {
  ranges: Range[];
  active: CellPos;
  anchor: CellPos;
}

export function cellSelection(row: number, col: number): Selection {
  return {
    ranges: [{ r1: row, c1: col, r2: row, c2: col }],
    active: { row, col },
    anchor: { row, col },
  };
}

export function rangeFrom(a: CellPos, b: CellPos): Range {
  return normalizeRange({ r1: a.row, c1: a.col, r2: b.row, c2: b.col });
}

/** The range the active cell is in (the last one). */
export function primaryRange(sel: Selection): Range {
  return sel.ranges[sel.ranges.length - 1]!;
}

/** Replaces the last range with anchor→`to`, keeping the anchor (shift+click, shift+arrow). */
export function extendTo(sel: Selection, to: CellPos): Selection {
  const ranges = sel.ranges.slice(0, -1);
  ranges.push(rangeFrom(sel.anchor, to));
  return { ranges, active: sel.anchor, anchor: sel.anchor };
}

export function wholeColumns(c1: number, c2: number): Range {
  return { r1: 0, c1: Math.min(c1, c2), r2: MAX_ROWS - 1, c2: Math.max(c1, c2) };
}

export function wholeRows(r1: number, r2: number): Range {
  return { r1: Math.min(r1, r2), c1: 0, r2: Math.max(r1, r2), c2: MAX_COLS - 1 };
}

export function isWholeColumns(r: Range): boolean {
  return r.r1 === 0 && r.r2 === MAX_ROWS - 1;
}

export function isWholeRows(r: Range): boolean {
  return r.c1 === 0 && r.c2 === MAX_COLS - 1;
}

export function selectionContains(sel: Selection, row: number, col: number): boolean {
  return sel.ranges.some((r) => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2);
}

/**
 * Clamps whole-row/column ranges to the sheet's grid so loops over a
 * selection never walk a million rows.
 */
export function clampToGrid(r: Range, rowCount: number, colCount: number): Range {
  return {
    r1: Math.min(r.r1, rowCount - 1),
    c1: Math.min(r.c1, colCount - 1),
    r2: Math.min(r.r2, rowCount - 1),
    c2: Math.min(r.c2, colCount - 1),
  };
}
