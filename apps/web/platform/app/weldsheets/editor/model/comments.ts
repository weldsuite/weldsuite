/**
 * Comments in the editor: threads on cells, as in Google Sheets. The
 * workbook holds one entry per thread (its cell, who started it and whether
 * it is resolved), set and removed by a `patchComments` op; what is said in
 * it is a thread in the sheet's WeldChat chat (ADR CHAT-007, see
 * `components/record-comments`). Commenters (a viewer with `sheets:comment`)
 * may start, move and remove only their own threads.
 */

import type { Sheet, SheetComment } from '@weldsuite/sheets-engine';
import type { SheetController } from './sheet-controller';

export interface Thread {
  /** The tab it is on. */
  tabId: string;
  comment: SheetComment;
}

export function newCommentId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `cm_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A tab's threads: on cells in reading order, then those whose cell was deleted. */
export function threadsOf(sheet: Sheet): Thread[] {
  const order = (c: SheetComment) => (c.cell ? c.cell.row * 20_000 + c.cell.col : Number.MAX_SAFE_INTEGER);
  return [...sheet.comments]
    .sort((a, b) => order(a) - order(b) || a.createdAt - b.createdAt)
    .map((comment) => ({ tabId: sheet.id, comment }));
}

/** The thread on a cell (an open one before a resolved one), if any. */
export function threadAt(sheet: Sheet, row: number, col: number): Thread | undefined {
  const here = threadsOf(sheet).filter((t) => t.comment.cell?.row === row && t.comment.cell?.col === col);
  return here.find((t) => !t.comment.resolved) ?? here[0];
}

/** Puts a thread on a cell of a tab (the active one by default); its first comment is in the chat under `id`. */
export function addThread(ctl: SheetController, id: string, cell: { row: number; col: number }, authorId: string, tabId = ctl.activeSheetId): SheetComment {
  const comment: SheetComment = { id, authorId, createdAt: Date.now(), cell: { ...cell } };
  ctl.commitComments({ type: 'patchComments', sheetId: tabId, set: [comment] });
  return comment;
}

/** Takes a thread off its cell (what was said stays in the chat). */
export function removeThread(ctl: SheetController, thread: Thread): void {
  ctl.commitComments({ type: 'patchComments', sheetId: thread.tabId, remove: [thread.comment.id] });
}

export function setResolved(ctl: SheetController, thread: Thread, resolved: boolean): void {
  const next: SheetComment = { ...thread.comment };
  if (resolved) next.resolved = true;
  else delete next.resolved;
  ctl.commitComments({ type: 'patchComments', sheetId: thread.tabId, set: [next] });
}
