/**
 * Comments and connected tables: what sits at a place in a sheet besides its
 * cells. Both are part of the sheet, so they co-edit, move with row and
 * column changes, undo, and travel with versions like the rest of it.
 *
 * A comment thread's discussion (its first comment, replies, mentions and
 * reactions) is a thread in the sheet's WeldChat record chat; the sheet keeps
 * one entry per thread with where it is and whether it is resolved, so the
 * thread follows its cell (ADR CHAT-007). A connected table of WeldSuite
 * data keeps its definition and refresh state in sheets-api; the sheet holds
 * only the block it last filled.
 */

import type { Range } from '../address';

export interface SheetComment {
  /** The thread's id: its messages in the sheet's chat carry it as `metadata.anchor.id`. */
  id: string;
  /** Who started the thread: a commenter may move or remove only their own. */
  authorId: string;
  /** Epoch ms. */
  createdAt: number;
  /** The discussion is done. */
  resolved?: boolean;
  /**
   * The cell the thread is on. Absent once that cell was deleted: the
   * discussion stays, without a cell.
   */
  cell?: { row: number; col: number };
}

/**
 * The block a connected table filled at its last refresh: its header row and
 * records. A refresh writes from the block's top-left cell and clears what
 * the new data no longer covers.
 */
export interface DataTable {
  /** The data source's id in sheets-api. */
  id: string;
  range: Range;
}

export function cloneComment(c: SheetComment): SheetComment {
  const out: SheetComment = { ...c };
  if (c.cell) out.cell = { ...c.cell };
  return out;
}

/**
 * Whether a stored comment is a thread entry. Workbooks from before comments
 * moved to WeldChat hold comments with their text, replies as entries of their
 * own; a workbook loads without those.
 */
export function isCommentEntry(c: unknown): c is SheetComment {
  const e = c as Partial<SheetComment> | null;
  return !!e && typeof e.id === 'string' && typeof e.authorId === 'string' && typeof e.createdAt === 'number';
}

export const cloneDataTable = (t: DataTable): DataTable => ({ id: t.id, range: { ...t.range } });

/** A comment after a row/column change on `axis`: a thread whose cell went (deleted, or pushed past `max`) keeps going without one. */
export function commentAfter(c: SheetComment, axis: 'row' | 'col', mapIndex: (i: number) => number, max: number): SheetComment {
  if (!c.cell) return c;
  const i = mapIndex(axis === 'row' ? c.cell.row : c.cell.col);
  if (i < 0 || i >= max) {
    const detached = { ...c };
    delete detached.cell;
    return detached;
  }
  return { ...c, cell: axis === 'row' ? { ...c.cell, row: i } : { ...c.cell, col: i } };
}
