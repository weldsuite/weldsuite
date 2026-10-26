/**
 * Comments in the editor: threads on cells, as in Google Sheets. A thread is
 * its first comment (which holds the cell and whether it is resolved) and the
 * replies after it; each comment is an entry in the workbook, set and removed
 * by a `patchComments` op (so two replies at once both stay). Commenters (a
 * viewer with `sheets:comment`) may add and change only their own.
 */

import { isThreadStart, type Sheet, type SheetComment } from '@weldsuite/sheets-engine';
import type { SheetController } from './sheet-controller';

export interface Thread {
  /** The tab it is on. */
  tabId: string;
  root: SheetComment;
  /** Oldest first. */
  replies: SheetComment[];
}

/** Who writes a comment. */
export interface CommentAuthor {
  id: string;
  name: string;
}

const MENTION = /@\[([^\]]*)\]\(([^)\s]+)\)/g;

/** The people a body mentions (`@[Name](id)`), each once. */
export function mentionsIn(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((m) => m[2]!))];
}

/** A body with its mentions as plain names (`@Name`). */
export function plainComment(body: string): string {
  return body.replace(MENTION, '@$1');
}

export function newCommentId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `cm_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A tab's threads: on cells in reading order, then those whose cell was deleted. */
export function threadsOf(sheet: Sheet): Thread[] {
  const replies = new Map<string, SheetComment[]>();
  const roots: SheetComment[] = [];
  for (const c of sheet.comments) {
    if (isThreadStart(c)) roots.push(c);
    else replies.set(c.thread, [...(replies.get(c.thread) ?? []), c]);
  }
  const order = (c: SheetComment) => (c.cell ? c.cell.row * 20_000 + c.cell.col : Number.MAX_SAFE_INTEGER);
  return roots
    .sort((a, b) => order(a) - order(b) || a.createdAt - b.createdAt)
    .map((root) => ({ tabId: sheet.id, root, replies: (replies.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt) }));
}

/** The thread on a cell (an open one before a resolved one), if any. */
export function threadAt(sheet: Sheet, row: number, col: number): Thread | undefined {
  const here = threadsOf(sheet).filter((t) => t.root.cell?.row === row && t.root.cell?.col === col);
  return here.find((t) => !t.root.resolved) ?? here[0];
}

function entry(author: CommentAuthor, body: string, thread?: string): SheetComment {
  const id = newCommentId();
  const mentions = mentionsIn(body);
  return {
    id,
    thread: thread ?? id,
    author: { ...author },
    createdAt: Date.now(),
    body: body.trim(),
    ...(mentions.length ? { mentions } : {}),
  };
}

/** Starts a thread on a cell of the active tab. */
export function addThread(ctl: SheetController, cell: { row: number; col: number }, body: string, author: CommentAuthor): SheetComment {
  const root = { ...entry(author, body), cell: { ...cell } };
  ctl.commitComments({ type: 'patchComments', sheetId: ctl.activeSheetId, set: [root] });
  return root;
}

export function reply(ctl: SheetController, thread: Thread, body: string, author: CommentAuthor): void {
  ctl.commitComments({ type: 'patchComments', sheetId: thread.tabId, set: [entry(author, body, thread.root.id)] });
}

export function editComment(ctl: SheetController, thread: Thread, comment: SheetComment, body: string): void {
  const mentions = mentionsIn(body);
  const next: SheetComment = { ...comment, body: body.trim(), editedAt: Date.now() };
  if (mentions.length) next.mentions = mentions;
  else delete next.mentions;
  ctl.commitComments({ type: 'patchComments', sheetId: thread.tabId, set: [next] });
}

/** Removes a reply, or a whole thread with its first comment. */
export function removeComment(ctl: SheetController, thread: Thread, comment: SheetComment): void {
  const ids = isThreadStart(comment) ? [comment.id, ...thread.replies.map((r) => r.id)] : [comment.id];
  ctl.commitComments({ type: 'patchComments', sheetId: thread.tabId, remove: ids });
}

export function setResolved(ctl: SheetController, thread: Thread, resolved: boolean): void {
  const next: SheetComment = { ...thread.root };
  if (resolved) next.resolved = true;
  else delete next.resolved;
  ctl.commitComments({ type: 'patchComments', sheetId: thread.tabId, set: [next] });
}
