import { describe, expect, it } from 'vitest';
import {
  DocModel,
  addComment,
  applyOp,
  batch,
  caretAt,
  deleteComment,
  editComment,
  replyToThread,
  setResolved,
  type Op,
} from '@weldsuite/docs-engine';
import { isCommentersOp } from './comment-access';

const CARA = 'cara';
const alice = { id: 'alice', name: 'Alice' };
const cara = { id: CARA, name: 'Cara' };

/** A document with some text and a discussion Alice started (`t_alice`). */
function setup(): DocModel {
  const doc = DocModel.create();
  applyOp(doc, { type: 'insert', story: 'body', at: 0, content: { text: 'Hello brave new world' } });
  applyOp(doc, addComment(doc, caretAt('body', 1), alice, { body: 'Why hello?' }, () => 't_alice', 1).op);
  return doc;
}

/** Applies a commenter's op when it passes; returns whether it did. */
function commit(doc: DocModel, op: Op, userId = CARA): boolean {
  const ok = isCommentersOp(op, userId, doc);
  if (ok) applyOp(doc, op);
  return ok;
}

describe('isCommentersOp', () => {
  it('lets a commenter start, edit, reply to and delete their own discussion', () => {
    const doc = setup();
    expect(commit(doc, addComment(doc, caretAt('body', 8), cara, { body: 'Brave?' }, () => 't_cara', 2).op)).toBe(true);
    expect(commit(doc, editComment(doc, 't_cara', { body: 'Really brave?' }, 3))).toBe(true);
    expect(commit(doc, replyToThread('t_cara', cara, { body: 'Yes' }, () => 'r_cara', 4))).toBe(true);
    expect(commit(doc, replyToThread('t_alice', cara, { body: 'Because' }, () => 'r_cara2', 5))).toBe(true);
    expect(commit(doc, deleteComment(doc, 't_cara'))).toBe(true);
    expect(doc.comments.has('t_cara')).toBe(false);
    expect(doc.anchors.has('t_cara')).toBe(false);
  });

  it('lets a commenter resolve and reopen anyone\'s discussion, and nothing more', () => {
    const doc = setup();
    expect(commit(doc, setResolved(doc, 't_alice', true))).toBe(true);
    expect(doc.comments.get('t_alice')?.resolved).toBe(true);
    expect(commit(doc, setResolved(doc, 't_alice', false))).toBe(true);
    // Resolving while changing the words is editing someone else's comment.
    const root = doc.comments.get('t_alice')!;
    expect(commit(doc, { type: 'patchComments', set: [{ ...root, resolved: true, body: 'Changed' }] })).toBe(false);
    // Only a discussion's first comment is resolved.
    applyOp(doc, replyToThread('t_alice', alice, { body: 'Hm' }, () => 'r_alice', 6));
    const reply = doc.comments.get('r_alice')!;
    expect(commit(doc, { type: 'patchComments', set: [{ ...reply, resolved: true }] })).toBe(false);
  });

  it('keeps a commenter off other people\'s comments and anchors', () => {
    const doc = setup();
    expect(commit(doc, editComment(doc, 't_alice', { body: 'Mine now' }, 7))).toBe(false);
    expect(commit(doc, deleteComment(doc, 't_alice'))).toBe(false);
    expect(commit(doc, { type: 'patchComments', remove: ['t_alice'] })).toBe(false);
    // A comment in someone else's name.
    expect(commit(doc, replyToThread('t_alice', alice, { body: 'Fake' }, () => 'r_fake', 8))).toBe(false);
    // Moving or dropping the anchor of Alice's discussion.
    expect(commit(doc, { type: 'patchAnchors', set: [{ id: 't_alice', kind: 'comment', story: 'body', from: 0, to: 2 }] })).toBe(false);
    expect(commit(doc, { type: 'patchAnchors', remove: ['t_alice'] })).toBe(false);
    // Deleting their own discussion takes Alice's reply with it: refused.
    applyOp(doc, addComment(doc, caretAt('body', 8), cara, { body: 'Mine' }, () => 't_cara', 9).op);
    applyOp(doc, replyToThread('t_cara', alice, { body: 'Reply' }, () => 'r_alice', 10));
    expect(commit(doc, deleteComment(doc, 't_cara'))).toBe(false);
  });

  it('refuses text, formatting, bookmarks and suggestion threads', () => {
    const doc = setup();
    const own = addComment(doc, caretAt('body', 8), cara, { body: 'x' }, () => 't_cara', 2).op;
    expect(commit(doc, { type: 'insert', story: 'body', at: 0, content: { text: 'x' } })).toBe(false);
    // A comment smuggled in next to a text edit refuses the whole batch.
    expect(commit(doc, batch([own, { type: 'delete', story: 'body', from: 0, to: 5 }]))).toBe(false);
    expect(commit(doc, { type: 'patchAnchors', set: [{ id: 'b1', kind: 'bookmark', story: 'body', from: 0, to: 2 }] })).toBe(false);
    // An anchor for a discussion nobody started.
    expect(commit(doc, { type: 'patchAnchors', set: [{ id: 't_none', kind: 'comment', story: 'body', from: 0, to: 2 }] })).toBe(false);
    const suggestion = { id: 't_sug', thread: 't_sug', author: cara, createdAt: 1, body: '', suggestion: 't_sug' };
    expect(commit(doc, { type: 'patchComments', set: [suggestion] })).toBe(false);
    expect(doc.stories.get('body')!.text(0, 5)).toBe('Hello');
  });

  it('judges a batch by who sends it', () => {
    const doc = setup();
    const own = addComment(doc, caretAt('body', 8), cara, { body: 'x' }, () => 't_cara', 2).op;
    expect(isCommentersOp(own, 'someone_else', doc)).toBe(false);
    expect(isCommentersOp(own, CARA, doc)).toBe(true);
  });
});
