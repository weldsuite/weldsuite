import { describe, expect, it, vi } from 'vitest';
import { EN_LOCALE } from '@weldsuite/sheets-engine';
import { addThread, removeThread, setResolved, threadAt, threadsOf } from './comments';
import { SheetController } from './sheet-controller';

const ALICE = 'user_alice';
const BOB = 'user_bob';

function make(options: { comments?: boolean } = {}) {
  const onOp = vi.fn();
  const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' }, onOp, ...options });
  return { ctl, onOp };
}

describe('comment threads', () => {
  it('puts a thread on a cell and marks the cell', () => {
    const { ctl, onOp } = make();
    const thread = addThread(ctl, 'cm_1', { row: 2, col: 1 }, ALICE);
    expect(thread).toMatchObject({ id: 'cm_1', authorId: ALICE, cell: { row: 2, col: 1 } });
    expect(threadAt(ctl.sheet, 2, 1)!.comment.id).toBe('cm_1');
    expect(ctl.commentAt(2, 1)).toBe(true);
    expect(ctl.commentAt(0, 0)).toBeUndefined();
    expect(onOp).toHaveBeenCalledTimes(1);
  });

  it('orders threads by cell, with an open thread on a cell before a resolved one', () => {
    const { ctl } = make();
    addThread(ctl, 'later', { row: 5, col: 0 }, ALICE);
    addThread(ctl, 'first', { row: 0, col: 3 }, ALICE);
    expect(threadsOf(ctl.sheet).map((t) => t.comment.id)).toEqual(['first', 'later']);

    addThread(ctl, 'done', { row: 5, col: 0 }, BOB);
    setResolved(ctl, threadAt(ctl.sheet, 5, 0)!, true);
    // The earlier thread was resolved; the newer one on the same cell is still open.
    expect(threadAt(ctl.sheet, 5, 0)!.comment.id).toBe('done');
    expect(ctl.commentAt(5, 0)).toBe(true);
    setResolved(ctl, threadAt(ctl.sheet, 5, 0)!, true);
    expect(ctl.commentAt(5, 0)).toBe(false);
    setResolved(ctl, threadsOf(ctl.sheet).find((t) => t.comment.id === 'later')!, false);
    expect(ctl.commentAt(5, 0)).toBe(true);
  });

  it('removes a thread', () => {
    const { ctl } = make();
    addThread(ctl, 'cm_1', { row: 0, col: 0 }, ALICE);
    removeThread(ctl, threadAt(ctl.sheet, 0, 0)!);
    expect(ctl.sheet.comments).toEqual([]);
    expect(ctl.commentAt(0, 0)).toBeUndefined();
  });

  it('lets a commenter comment on a read-only sheet, and nobody else', () => {
    const { ctl, onOp } = make();
    ctl.setReadOnly(true);
    expect(ctl.mayComment).toBe(false);
    addThread(ctl, 'ignored', { row: 0, col: 0 }, ALICE);
    ctl.startComment();
    expect(ctl.sheet.comments).toEqual([]);
    expect(ctl.panel).toBeNull();
    expect(onOp).not.toHaveBeenCalled();

    ctl.setCanComment(true);
    expect(ctl.mayComment).toBe(true);
    addThread(ctl, 'kept', { row: 0, col: 0 }, ALICE);
    expect(ctl.sheet.comments.map((c) => c.id)).toEqual(['kept']);
    ctl.startComment();
    expect(ctl.panel).toBe('comments');
    expect(ctl.commentRequested).toBe(true);
  });

  it('has no comments where the sheet has no chat (a preview kept in the browser)', () => {
    const { ctl } = make({ comments: false });
    expect(ctl.mayComment).toBe(false);
    ctl.startComment();
    expect(ctl.panel).toBeNull();
  });

  it('keeps comments out of undo: undo reverses the edit before them, not the comment', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, '42');
    addThread(ctl, 'why', { row: 0, col: 0 }, ALICE);
    ctl.undo();
    expect(ctl.engine.getValue(ctl.activeSheetId, 0, 0)).toBeNull();
    expect(ctl.sheet.comments.map((c) => c.id)).toEqual(['why']);
  });

  it('opens the comments panel on a thread', () => {
    const { ctl } = make();
    addThread(ctl, 'look', { row: 1, col: 1 }, ALICE);
    ctl.openThread('look');
    expect(ctl.panel).toBe('comments');
    expect(ctl.focusedThread).toBe('look');
  });
});
