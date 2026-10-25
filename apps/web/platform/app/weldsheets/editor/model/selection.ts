import { MAX_COLS, MAX_ROWS, normalizeRange, transform, type Op, type Range } from '@weldsuite/sheets-engine';

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

/**
 * Where a cell of sheet `sheetId` is once `op` (someone else's, already
 * applied) has run: rows and columns inserted, deleted or moved before it shift
 * it, an op on another sheet leaves it. Null when its row or column was deleted.
 * Rides on `transform`, which moves a cell write the same way, so the
 * selection follows the data exactly as pending ops do.
 */
export function cellAfter(op: Op, sheetId: string, pos: CellPos): CellPos | null {
  const moved = transform({ type: 'setCells', sheetId, cells: [[pos.row, pos.col, null]] }, op, true);
  if (moved.type !== 'setCells' || moved.cells.length === 0) return null;
  const [row, col] = moved.cells[0]!;
  return { row, col };
}

/**
 * Where a selection is once `op` has run, by the same rule as `cellAfter`:
 * ranges widen over rows inserted inside them, shrink over rows deleted from
 * them and follow a move. A selection whose active or anchor cell was deleted,
 * or that lost all its cells, collapses to the active cell's old position (now
 * the row or column that followed the deleted ones). Returns `sel` itself when
 * nothing moved.
 */
export function selectionAfter(op: Op, sheetId: string, sel: Selection): Selection {
  const active = cellAfter(op, sheetId, sel.active);
  const anchor = cellAfter(op, sheetId, sel.anchor);
  // `unmerge` carries ranges through the same structural change without splitting around an insert.
  const moved = transform({ type: 'unmerge', sheetId, ranges: sel.ranges }, op, true);
  const ranges = moved.type === 'unmerge' ? moved.ranges : [];
  if (!active || !anchor || ranges.length === 0) return cellSelection(sel.active.row, sel.active.col);
  const same =
    active.row === sel.active.row &&
    active.col === sel.active.col &&
    anchor.row === sel.anchor.row &&
    anchor.col === sel.anchor.col &&
    ranges.length === sel.ranges.length &&
    ranges.every((r, i) => {
      const o = sel.ranges[i]!;
      return r.r1 === o.r1 && r.c1 === o.c1 && r.r2 === o.r2 && r.c2 === o.c2;
    });
  return same ? sel : { ranges, active, anchor };
}
