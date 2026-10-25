import {
  caretAt,
  cellOf,
  cellStoryAt,
  clearCells,
  deleteDims,
  deleteTable,
  distributeColumns,
  findTable,
  formatCells,
  formatTable,
  insertCols,
  insertRows,
  insertTable,
  mergeAnchor,
  mergeCells,
  setHeaderRows,
  unmergeCell,
  type CellRef,
  type DocSelection,
  type Op,
  type TableData,
} from '@weldsuite/docs-engine';
import type { DocController } from './doc-controller';

/** The table the caret is in, and where. */
export interface TableContext extends CellRef {
  rows: number;
  cols: number;
  /** The caret's cell is a merged one (or covered by one). */
  merged: boolean;
  /** Rows marked as header rows. */
  headerRows: number;
}

export function tableContext(ctl: DocController): TableContext | null {
  const cell = cellOf(ctl.doc, ctl.selection.story);
  if (!cell) return null;
  const t = ctl.doc.tables.get(cell.tableId)!;
  const props = t.cells?.[`${cell.rowId}:${cell.colId}`];
  let headerRows = 0;
  while (headerRows < t.rows.length && t.rows[headerRows]!.header) headerRows++;
  return { ...cell, rows: t.rows.length, cols: t.cols.length, merged: !!(props?.rowSpan || props?.colSpan), headerRows };
}

export type TableAction =
  | 'rowAbove'
  | 'rowBelow'
  | 'colLeft'
  | 'colRight'
  | 'deleteRow'
  | 'deleteCol'
  | 'deleteTable'
  | 'mergeRight'
  | 'mergeDown'
  | 'unmerge'
  | 'distribute'
  | 'headerRow'
  | 'clear';

/** Runs a table command on the table the caret is in; the caret stays in a sensible cell. */
export function runTableAction(ctl: DocController, action: TableAction): void {
  const ctx = tableContext(ctl);
  if (!ctx || ctl.readOnly) return;
  const { tableId, row, col } = ctx;
  const doc = ctl.doc;
  let op: Op;
  let next: { row: number; col: number } | null = { row, col };
  switch (action) {
    case 'rowAbove':
      op = insertRows(doc, tableId, row);
      next = { row, col };
      break;
    case 'rowBelow':
      op = insertRows(doc, tableId, row + 1);
      next = { row: row + 1, col };
      break;
    case 'colLeft':
      op = insertCols(doc, tableId, col);
      next = { row, col };
      break;
    case 'colRight':
      op = insertCols(doc, tableId, col + 1);
      next = { row, col: col + 1 };
      break;
    case 'deleteRow':
      op = deleteDims(doc, tableId, 'row', row, 1);
      next = ctx.rows > 1 ? { row: Math.min(row, ctx.rows - 2), col } : null;
      break;
    case 'deleteCol':
      op = deleteDims(doc, tableId, 'col', col, 1);
      next = ctx.cols > 1 ? { row, col: Math.min(col, ctx.cols - 2) } : null;
      break;
    case 'deleteTable':
      op = deleteTable(doc, tableId);
      next = null;
      break;
    case 'mergeRight':
      op = mergeCells(doc, tableId, row, col, row, Math.min(ctx.cols - 1, col + 1));
      break;
    case 'mergeDown':
      op = mergeCells(doc, tableId, row, col, Math.min(ctx.rows - 1, row + 1), col);
      break;
    case 'unmerge':
      op = unmergeCell(doc, tableId, row, col);
      break;
    case 'distribute':
      op = distributeColumns(doc, tableId);
      break;
    case 'headerRow':
      op = setHeaderRows(doc, tableId, ctx.headerRows > 0 ? 0 : 1);
      break;
    case 'clear':
      op = clearCells(doc, tableId, row, col, row, col);
      break;
  }
  // Where the caret goes: into the chosen cell once the op is applied, or after the table when it went.
  const where = next ? null : findTable(doc, tableId);
  ctl.apply({ op, selection: ctl.selection });
  if (next) {
    const story = cellStoryAt(ctl.doc, tableId, next.row, next.col);
    if (story) ctl.setSelection(caretAt(story, 0));
  } else if (where) {
    const story = ctl.doc.stories.get(where.story);
    if (story) ctl.setSelection(caretAt(where.story, Math.min(where.pos, story.length - 1)));
  }
}

/** Cell formatting for the caret's cell (background, vertical alignment). */
export function formatCell(ctl: DocController, patch: Parameters<typeof formatCells>[6]): void {
  const ctx = tableContext(ctl);
  if (!ctx) return;
  const a = mergeAnchor(ctl.doc.tables.get(ctx.tableId)!, ctx.row, ctx.col);
  ctl.apply(formatCells(ctl.doc, ctx.tableId, a.row, a.col, a.row, a.col, patch));
}

export function formatCurrentTable(ctl: DocController, patch: Parameters<typeof formatTable>[1]): void {
  const ctx = tableContext(ctl);
  if (ctx) ctl.apply(formatTable(ctx.tableId, patch));
}

/** Inserts a table at the caret (in the body, a header, a footer or a cell) and moves into its first cell. */
export function insertTableAtCaret(ctl: DocController, rows: number, cols: number): void {
  if (ctl.readOnly) return;
  ctl.apply(insertTable(ctl.doc, ctl.selection, rows, cols));
}

/**
 * Tab and Shift+Tab inside a table: to the next or previous cell (its text
 * selected, as in Google Docs); Tab in the last cell adds a row. Returns
 * false outside a table.
 */
export function moveToCell(ctl: DocController, dir: 1 | -1): boolean {
  const ctx = tableContext(ctl);
  if (!ctx) return false;
  const next = nextCell(ctl.doc.tables.get(ctx.tableId)!, ctx, dir);
  if (next === 'before') return true;
  if (next === 'after') {
    if (!ctl.readOnly) {
      ctl.apply(insertRows(ctl.doc, ctx.tableId, ctx.rows));
      const story = cellStoryAt(ctl.doc, ctx.tableId, ctx.rows, 0);
      if (story) ctl.setSelection(caretAt(story, 0));
    }
    return true;
  }
  const story = cellStoryAt(ctl.doc, ctx.tableId, next.row, next.col);
  if (!story) return true;
  const end = ctl.doc.stories.get(story)!.length - 1;
  const sel: DocSelection = { story, anchor: 0, head: end };
  ctl.setSelection(sel);
  return true;
}

/** The next (or previous) cell in reading order, skipping cells covered by a merge; or past the table's start or end. */
function nextCell(t: TableData, ctx: TableContext, dir: 1 | -1): { row: number; col: number } | 'before' | 'after' {
  let { row, col } = mergeAnchor(t, ctx.row, ctx.col);
  for (;;) {
    col += dir;
    if (col >= ctx.cols || col < 0) {
      row += dir;
      col = dir > 0 ? 0 : ctx.cols - 1;
    }
    if (row < 0) return 'before';
    if (row >= ctx.rows) return 'after';
    const a = mergeAnchor(t, row, col);
    if (a.row === row && a.col === col) return { row, col };
  }
}

/**
 * Up or Down from the first or last line of a cell: to the cell above or
 * below, or out of the table. Returns false when the caret should move
 * within the cell as usual.
 */
export function leaveCell(ctl: DocController, dir: 1 | -1): boolean {
  const ctx = tableContext(ctl);
  if (!ctx) return false;
  const t = ctl.doc.tables.get(ctx.tableId)!;
  const a = mergeAnchor(t, ctx.row, ctx.col);
  const span = t.cells?.[`${t.rows[a.row]!.id}:${t.cols[a.col]!.id}`]?.rowSpan ?? 1;
  const target = dir > 0 ? a.row + span : a.row - 1;
  if (target >= 0 && target < ctx.rows) {
    const story = cellStoryAt(ctl.doc, ctx.tableId, target, ctx.col);
    if (story) {
      ctl.setSelection(caretAt(story, dir > 0 ? 0 : ctl.doc.stories.get(story)!.length - 1));
      return true;
    }
  }
  const where = findTable(ctl.doc, ctx.tableId);
  if (!where) return false;
  const owner = ctl.doc.stories.get(where.story)!;
  ctl.setSelection(caretAt(where.story, dir > 0 ? Math.min(where.pos + 1, owner.length - 1) : Math.max(0, where.pos)));
  return true;
}
