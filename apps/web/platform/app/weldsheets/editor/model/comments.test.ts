import { describe, expect, it, vi } from 'vitest';
import { EN_LOCALE } from '@weldsuite/sheets-engine';
import { addThread, editComment, mentionsIn, plainComment, removeComment, reply, setResolved, threadAt, threadsOf } from './comments';
import { SheetController } from './sheet-controller';

const ALICE = { id: 'user_alice', name: 'Alice' };
const BOB = { id: 'user_bob', name: 'Bob' };

function make() {
  const onOp = vi.fn();
  const ctl = new SheetController(null, { locale: EN_LOCALE, formulaLocale: { decimal: '.' }, onOp });
  return { ctl, onOp };
}

describe('comment bodies', () => {
  it('finds each mentioned person once and shows mentions as names', () => {
    const body = 'Hi @[Bob](user_bob), see @[Carol](user_carol) and @[Bob](user_bob)';
    expect(mentionsIn(body)).toEqual(['user_bob', 'user_carol']);
    expect(plainComment(body)).toBe('Hi @Bob, see @Carol and @Bob');
    expect(mentionsIn('no one')).toEqual([]);
  });
});

describe('comment threads', () => {
  it('starts a thread on a cell, takes replies in order and marks the cell', () => {
    const { ctl, onOp } = make();
    const root = addThread(ctl, { row: 2, col: 1 }, '  Is this right? @[Bob](user_bob) ', ALICE);
    expect(root).toMatchObject({ thread: root.id, cell: { row: 2, col: 1 }, body: 'Is this right? @[Bob](user_bob)', mentions: ['user_bob'] });
    const thread = threadAt(ctl.sheet, 2, 1)!;
    reply(ctl, thread, 'Yes', BOB);
    reply(ctl, thread, 'Thanks', ALICE);

    const [only] = threadsOf(ctl.sheet);
    expect(only!.root.id).toBe(root.id);
    expect(only!.replies.map((r) => r.body)).toEqual(['Yes', 'Thanks']);
    expect(only!.replies.every((r) => r.thread === root.id && !r.cell)).toBe(true);
    expect(ctl.commentAt(2, 1)).toBe(true);
    expect(ctl.commentAt(0, 0)).toBeUndefined();
    expect(onOp).toHaveBeenCalledTimes(3);
  });

  it('orders threads by cell, with an open thread on a cell before a resolved one', () => {
    const { ctl } = make();
    const later = addThread(ctl, { row: 5, col: 0 }, 'Later', ALICE);
    const first = addThread(ctl, { row: 0, col: 3 }, 'First', ALICE);
    expect(threadsOf(ctl.sheet).map((t) => t.root.id)).toEqual([first.id, later.id]);

    const resolved = addThread(ctl, { row: 5, col: 0 }, 'Done', BOB);
    setResolved(ctl, threadAt(ctl.sheet, 5, 0)!, true);
    // The earlier thread was resolved; the newer one on the same cell is still open.
    expect(threadAt(ctl.sheet, 5, 0)!.root.id).toBe(resolved.id);
    expect(ctl.commentAt(5, 0)).toBe(true);
    setResolved(ctl, threadAt(ctl.sheet, 5, 0)!, true);
    expect(ctl.commentAt(5, 0)).toBe(false);
    setResolved(ctl, threadsOf(ctl.sheet).find((t) => t.root.id === later.id)!, false);
    expect(ctl.commentAt(5, 0)).toBe(true);
  });

  it('edits a comment (with its mentions) and removes a reply or a whole thread', () => {
    const { ctl } = make();
    addThread(ctl, { row: 0, col: 0 }, 'Hello @[Bob](user_bob)', ALICE);
    let thread = threadAt(ctl.sheet, 0, 0)!;
    editComment(ctl, thread, thread.root, 'Hello everyone');
    thread = threadAt(ctl.sheet, 0, 0)!;
    expect(thread.root.body).toBe('Hello everyone');
    expect(thread.root.mentions).toBeUndefined();
    expect(thread.root.editedAt).toBeTypeOf('number');

    reply(ctl, thread, 'One', BOB);
    reply(ctl, thread, 'Two', BOB);
    thread = threadAt(ctl.sheet, 0, 0)!;
    removeComment(ctl, thread, thread.replies[0]!);
    expect(threadAt(ctl.sheet, 0, 0)!.replies.map((r) => r.body)).toEqual(['Two']);

    removeComment(ctl, threadAt(ctl.sheet, 0, 0)!, threadAt(ctl.sheet, 0, 0)!.root);
    expect(ctl.sheet.comments).toEqual([]);
    expect(ctl.commentAt(0, 0)).toBeUndefined();
  });

  it('lets a commenter comment on a read-only sheet, and nobody else', () => {
    const { ctl, onOp } = make();
    ctl.setReadOnly(true);
    expect(ctl.mayComment).toBe(false);
    addThread(ctl, { row: 0, col: 0 }, 'Ignored', ALICE);
    ctl.startComment();
    expect(ctl.sheet.comments).toEqual([]);
    expect(ctl.panel).toBeNull();
    expect(onOp).not.toHaveBeenCalled();

    ctl.setCanComment(true);
    expect(ctl.mayComment).toBe(true);
    addThread(ctl, { row: 0, col: 0 }, 'Kept', ALICE);
    expect(ctl.sheet.comments.map((c) => c.body)).toEqual(['Kept']);
    ctl.startComment();
    expect(ctl.panel).toBe('comments');
    expect(ctl.commentRequested).toBe(true);
  });

  it('keeps comments out of undo: undo reverses the edit before them, not the comment', () => {
    const { ctl } = make();
    ctl.setInput(0, 0, '42');
    addThread(ctl, { row: 0, col: 0 }, 'Why 42?', ALICE);
    ctl.undo();
    expect(ctl.engine.getValue(ctl.activeSheetId, 0, 0)).toBeNull();
    expect(ctl.sheet.comments.map((c) => c.body)).toEqual(['Why 42?']);
  });

  it('opens the comments panel on a thread', () => {
    const { ctl } = make();
    const root = addThread(ctl, { row: 1, col: 1 }, 'Look', ALICE);
    ctl.openThread(root.id);
    expect(ctl.panel).toBe('comments');
    expect(ctl.focusedThread).toBe(root.id);
  });
});
