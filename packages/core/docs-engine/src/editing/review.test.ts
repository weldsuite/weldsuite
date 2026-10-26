import { describe, expect, it } from 'vitest';
import { DocModel } from '../model/document';
import { BODY } from '../model/objects';
import { applyOp } from '../ops/apply';
import type { Op } from '../ops/types';
import { validateOp } from '../ops/validate';
import { counterIds, snapshotKey } from '../test-support';
import { caretAt, insertText } from './commands';
import {
  addComment,
  deleteThread,
  resolveSuggestion,
  setResolved,
  suggestDeleteChar,
  suggestText,
  suggestionIds,
  suggestionRanges,
  suggestSplit,
  threadsOf,
} from './review';

const ANN = { id: 'u-ann', name: 'Ann' };
const BOB = { id: 'u-bob', name: 'Bob' };

function run(d: DocModel, op: Op): Op {
  expect(validateOp(d, op)).toBeNull();
  return applyOp(d, op);
}

function docWith(text: string): DocModel {
  const d = DocModel.create();
  run(d, insertText(d, caretAt(BODY, 0), text).op);
  return d;
}

const kinds = (d: DocModel) =>
  d.body
    .text()
    .split('')
    .map((_, i) => d.textStyles.get(d.body.styleAt(i)).suggestion?.kind?.[0] ?? '.')
    .join('');

describe('comments', () => {
  it('starts a discussion on the word at the caret, resolves it, and deletes it with its anchor', () => {
    const d = docWith('Hello brave world');
    const ids = counterIds('c');
    const started = addComment(d, caretAt(BODY, 8), ANN, ids, 10);
    run(d, started.op);
    expect(started.quote).toBe('brave');
    expect(d.anchors.get(started.thread)).toMatchObject({ kind: 'comment', from: 6, to: 11 });
    expect(d.comments.get(started.thread)).toEqual({ id: started.thread, author: ANN, createdAt: 10, quote: 'brave' });

    run(d, setResolved(d, started.thread, true));
    const [thread] = threadsOf(d);
    expect(thread!.root).toMatchObject({ resolved: true });
    expect(thread!.at).toEqual({ story: BODY, from: 6, to: 11 });

    const before = snapshotKey(d);
    const undo = run(d, deleteThread(d, started.thread));
    expect(d.comments.size).toBe(0);
    expect(d.anchors.size).toBe(0);
    applyOp(d, undo);
    expect(snapshotKey(d)).toBe(before);
  });

  it('lists discussions in the order of their text', () => {
    const d = docWith('one two three');
    const third = addComment(d, { story: BODY, anchor: 8, head: 13 }, ANN, counterIds('a'));
    run(d, third.op);
    const first = addComment(d, { story: BODY, anchor: 0, head: 3 }, ANN, counterIds('b'));
    run(d, first.op);
    expect(threadsOf(d).map((t) => t.root.id)).toEqual([first.thread, third.thread]);
  });

  it('keeps comments in snapshots, and documents without them stay as they were', () => {
    const plain = docWith('Text');
    expect('comments' in plain.toSnapshot()).toBe(false);
    run(plain, addComment(plain, caretAt(BODY, 1), ANN, counterIds('c')).op);
    const copy = DocModel.fromSnapshot(plain.toSnapshot());
    expect(snapshotKey(copy)).toBe(snapshotKey(plain));
  });

  it('loads a document from before comments moved to WeldChat without its comment threads, keeping who suggested what', () => {
    const d = docWith('Hello world');
    const snapshot = d.toSnapshot();
    snapshot.anchors.push({ id: 'old', kind: 'comment', story: BODY, from: 0, to: 5 });
    (snapshot as { comments?: unknown[] }).comments = [
      { id: 'old', thread: 'old', author: ANN, createdAt: 1, body: 'Hi', quote: 'Hello' },
      { id: 'old-r', thread: 'old', author: BOB, createdAt: 2, body: 'Yes' },
      { id: 'sg', thread: 'sg', author: BOB, createdAt: 3, body: '', suggestion: 'sg' },
    ];
    const loaded = DocModel.fromSnapshot(snapshot);
    expect([...loaded.comments.values()]).toEqual([{ id: 'sg', author: BOB, createdAt: 3, suggestion: 'sg' }]);
    expect(loaded.anchors.has('old')).toBe(false);
  });
});

describe('suggestions', () => {
  it('marks typed text as an insertion, one suggestion while typing on', () => {
    const d = docWith('Hello world');
    const ids = counterIds('s');
    let sel = caretAt(BODY, 5);
    for (const ch of ', dear') {
      const e = suggestText(d, sel, ch, ANN, null, ids);
      run(d, e.op);
      sel = e.selection;
    }
    expect(d.body.text()).toBe('Hello, dear world\n');
    expect(kinds(d)).toBe('.....iiiiii.......');
    expect(suggestionIds(d)).toHaveLength(1);
    expect(d.comments.get(suggestionIds(d)[0]!)).toMatchObject({ author: ANN, suggestion: suggestionIds(d)[0] });
  });

  it('marks deleted text instead of deleting it, and deletes your own suggested text outright', () => {
    const d = docWith('Hello world');
    const ids = counterIds('s');
    let sel = caretAt(BODY, 11);
    for (let i = 0; i < 3; i++) {
      const e = suggestDeleteChar(d, sel, ANN, -1, ids);
      run(d, e.op);
      sel = e.selection;
    }
    expect(d.body.text()).toBe('Hello world\n');
    expect(kinds(d)).toBe('........ddd.');
    expect(sel.head).toBe(8);
    // Ann's own insertion goes for good.
    const typed = suggestText(d, caretAt(BODY, 5), '!', ANN, null, ids);
    run(d, typed.op);
    run(d, suggestDeleteChar(d, typed.selection, ANN, -1, ids).op);
    expect(d.body.text()).toBe('Hello world\n');
  });

  it("marks someone else's suggested text deleted, not gone", () => {
    const d = docWith('Hi');
    const typed = suggestText(d, caretAt(BODY, 2), '!', ANN, null, counterIds('a'));
    run(d, typed.op);
    run(d, suggestDeleteChar(d, typed.selection, BOB, -1, counterIds('b')).op);
    expect(d.body.text()).toBe('Hi!\n');
    expect(kinds(d)).toBe('..d.');
  });

  it('suggests a new paragraph; rejecting it joins them again', () => {
    const d = docWith('Hello world');
    const e = suggestSplit(d, caretAt(BODY, 5), ANN, counterIds('s'));
    run(d, e.op);
    expect(d.body.text()).toBe('Hello\n world\n');
    expect(kinds(d)).toBe('.....i.......');
    run(d, resolveSuggestion(d, suggestionIds(d)[0]!, false));
    expect(d.body.text()).toBe('Hello world\n');
  });

  it('accepts and rejects, and undoes either', () => {
    for (const accept of [true, false]) {
      const d = docWith('Hello world');
      const ids = counterIds('s');
      run(d, suggestText(d, { story: BODY, anchor: 6, head: 11 }, 'there', ANN, null, ids).op);
      expect(d.body.text()).toBe('Hello worldthere\n');
      const [del, ins] = suggestionIds(d);
      expect(suggestionRanges(d, del!)).toEqual([{ story: BODY, from: 6, to: 11, kind: 'delete' }]);
      const before = snapshotKey(d);
      const undoDel = run(d, resolveSuggestion(d, del!, accept));
      const undoIns = run(d, resolveSuggestion(d, ins!, accept));
      expect(d.body.text()).toBe(accept ? 'Hello there\n' : 'Hello world\n');
      expect(kinds(d)).toBe('.'.repeat(d.body.length));
      expect(d.comments.size).toBe(0);
      applyOp(d, undoIns);
      applyOp(d, undoDel);
      expect(snapshotKey(d)).toBe(before);
    }
  });
});
