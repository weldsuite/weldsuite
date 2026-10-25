/**
 * Comments and connected tables: what sits at a place in a sheet besides its
 * cells. Both are part of the sheet, so they co-edit, move with row and
 * column changes, undo, and travel with versions like the rest of it.
 *
 * A comment is an entry of a thread (the thread's first comment and its
 * replies, each by id, so two replies at once both stay), as in WeldDocs. The
 * first comment holds the cell the thread is on. A connected table of
 * WeldSuite data keeps its definition and refresh state in sheets-api; the
 * sheet holds only the block it last filled.
 */

import type { Range } from '../address';

export interface SheetComment {
  id: string;
  /** The id of the thread's first comment. */
  thread: string;
  author: { id: string; name: string };
  /** Epoch ms. */
  createdAt: number;
  editedAt?: number;
  /** Plain text; a mention is written `@[Name](userId)`. */
  body: string;
  /** People mentioned in `body` (user ids), to notify. */
  mentions?: string[];
  /** First comment only: the discussion is done. */
  resolved?: boolean;
  /**
   * First comment only: the cell the thread is on. Absent once that cell was
   * deleted: the discussion stays, without a cell.
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

export const MAX_COMMENT_LENGTH = 10_000;
export const MAX_MENTIONS = 50;

export function cloneComment(c: SheetComment): SheetComment {
  const out: SheetComment = { ...c, author: { ...c.author } };
  if (c.mentions) out.mentions = [...c.mentions];
  if (c.cell) out.cell = { ...c.cell };
  return out;
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

/** A thread's first comment (the one holding its cell and resolved state). */
export const isThreadStart = (c: SheetComment): boolean => c.thread === c.id;
