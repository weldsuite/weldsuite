/**
 * Review: comments and suggestions. Pure functions returning ops, like the
 * text commands.
 *
 * A comment thread is a comment anchor on the text plus its discussion entry
 * (`DocComment`, same id). What is said in it is in the document's WeldChat
 * chat, in messages that carry the thread's id (ADR CHAT-007).
 *
 * A suggestion is text marked with a `suggestion` style: typed text is
 * inserted marked `insert`, deleted text stays in place marked `delete`.
 * Accepting removes the mark (insert) or the text (delete); rejecting does
 * the opposite. Who suggested it, and the discussion about it, live in a
 * thread whose id is the suggestion's.
 */

import { LINE_BREAK, OBJECT, PARA } from '../model/chars';
import type { DocModel } from '../model/document';
import { newId } from '../model/ids';
import type { DocComment } from '../model/objects';
import type { TextStyle } from '../model/styles';
import { batch, NOOP, type Op } from '../ops/types';
import { nextGrapheme, wordAt } from './boundaries';
import { caretAt, insertText, isCollapsed, selectionRange, splitParagraph, type DocSelection, type Edit } from './commands';
import { storiesInOrder } from './find';

export interface Reviewer {
  id: string;
  name: string;
}

type Suggestion = NonNullable<TextStyle['suggestion']>;

/** Marks, breaks and objects, shown as spaces in a comment's quote. */
const HIDDEN = new RegExp(`[${PARA}${LINE_BREAK}${OBJECT}]`, 'g');

// ---------------------------------------------------------------- comments

/**
 * Starts a discussion on the selection (or the word at the caret): the op
 * that marks it, its id and the text it is about, for the first message in
 * the document's chat. The caret stays where it is.
 */
export function addComment(doc: DocModel, sel: DocSelection, author: Reviewer, makeId: () => string = newId, now = Date.now()): { op: Op; thread: string; quote: string } {
  const story = doc.stories.get(sel.story);
  if (!story) return { op: NOOP, thread: '', quote: '' };
  let { from, to } = selectionRange(sel);
  if (from === to) ({ from, to } = wordAt(story, from));
  const id = makeId();
  const comment: DocComment = { id, author: { ...author }, createdAt: now };
  const quote = story.text(from, to).replace(HIDDEN, ' ').trim().slice(0, 200);
  if (quote) comment.quote = quote;
  return {
    op: batch([
      { type: 'patchAnchors', set: [{ id, kind: 'comment', story: sel.story, from, to }] },
      { type: 'patchComments', set: [comment] },
    ]),
    thread: id,
    quote,
  };
}

export function setResolved(doc: DocModel, thread: string, resolved: boolean): Op {
  const root = doc.comments.get(thread);
  if (!root) return NOOP;
  const next: DocComment = { ...root };
  if (resolved) next.resolved = true;
  else delete next.resolved;
  return { type: 'patchComments', set: [next] };
}

/** Deletes a discussion and its anchor (what was said in it stays in the chat). */
export function deleteThread(doc: DocModel, id: string): Op {
  if (!doc.comments.has(id)) return NOOP;
  const ops: Op[] = [{ type: 'patchComments', remove: [id] }];
  if (doc.anchors.has(id)) ops.push({ type: 'patchAnchors', remove: [id] });
  return batch(ops);
}

export interface Thread {
  root: DocComment;
  /** Where it is in the text (its anchor, or a suggestion's first stretch); null when that text is gone. */
  at: { story: string; from: number; to: number } | null;
}

/** Every discussion, in the order of the text it is about (those whose text is gone last). */
export function threadsOf(doc: DocModel): Thread[] {
  const order = new Map(storiesInOrder(doc).map((id, i) => [id, i]));
  const suggestionAt = suggestionStarts(doc);
  const threads = [...doc.comments.values()].map((root): Thread => {
    const at = root.suggestion ? (suggestionAt.get(root.suggestion) ?? null) : anchorPlace(doc, root.id);
    return { root, at };
  });
  const key = (t: Thread) => (t.at ? [order.get(t.at.story) ?? 1e9, t.at.from] : [2e9, t.root.createdAt]);
  return threads.sort((a, b) => {
    const [sa, pa] = key(a);
    const [sb, pb] = key(b);
    return sa! - sb! || pa! - pb! || (a.root.id < b.root.id ? -1 : 1);
  });
}

/** Where a comment anchor is, while its story is there. */
function anchorPlace(doc: DocModel, id: string): Thread['at'] {
  const anchor = doc.anchors.get(id);
  return anchor && doc.stories.has(anchor.story) ? { story: anchor.story, from: anchor.from, to: anchor.to } : null;
}

// ---------------------------------------------------------------- suggestions

export interface SuggestionRange {
  story: string;
  from: number;
  to: number;
  kind: Suggestion['kind'];
}

/** The stretches of text a suggestion marks, story by story, in order. */
export function suggestionRanges(doc: DocModel, id: string): SuggestionRange[] {
  const out: SuggestionRange[] = [];
  for (const storyId of storiesInOrder(doc)) {
    const story = doc.stories.get(storyId)!;
    story.forEachRun(0, story.length, (start, end, styleId) => {
      const s = doc.textStyles.get(styleId).suggestion;
      if (s?.id !== id) return;
      const last = out[out.length - 1];
      if (last && last.story === storyId && last.to === start && last.kind === s.kind) last.to = end;
      else out.push({ story: storyId, from: start, to: end, kind: s.kind });
    });
  }
  return out;
}

/** Where each suggestion starts. */
function suggestionStarts(doc: DocModel): Map<string, { story: string; from: number; to: number }> {
  const out = new Map<string, { story: string; from: number; to: number }>();
  for (const storyId of storiesInOrder(doc)) {
    const story = doc.stories.get(storyId)!;
    story.forEachRun(0, story.length, (start, end, styleId) => {
      const s = doc.textStyles.get(styleId).suggestion;
      if (!s) return;
      const at = out.get(s.id);
      if (!at) out.set(s.id, { story: storyId, from: start, to: end });
      else if (at.story === storyId && at.to === start) at.to = end;
    });
  }
  return out;
}

function suggestionAt(doc: DocModel, storyId: string, pos: number): Suggestion | undefined {
  const story = doc.stories.get(storyId);
  if (!story || pos < 0 || pos >= story.length) return undefined;
  return doc.textStyles.get(story.styleAt(pos)).suggestion;
}

/** The suggestion of this kind by this person right next to `pos`, to carry on (typing on extends it). */
function ownNeighbour(doc: DocModel, storyId: string, positions: number[], kind: Suggestion['kind'], author: Reviewer): string | null {
  for (const p of positions) {
    const s = suggestionAt(doc, storyId, p);
    if (s?.kind === kind && doc.comments.get(s.id)?.author.id === author.id) return s.id;
  }
  return null;
}

function newSuggestionThread(id: string, author: Reviewer, now: number): Op {
  return { type: 'patchComments', set: [{ id, author: { ...author }, createdAt: now, suggestion: id }] };
}

/**
 * Typing in suggesting mode: the text goes in marked as an insertion
 * (selected text is marked deleted first, and the new text follows it).
 */
export function suggestText(doc: DocModel, sel: DocSelection, text: string, author: Reviewer, pending: TextStyle | null = null, makeId: () => string = newId, now = Date.now()): Edit {
  const ops: Op[] = [];
  let at = selectionRange(sel).from;
  if (!isCollapsed(sel)) {
    const del = suggestDelete(doc, sel, author, 1, makeId, now);
    ops.push(del.op);
    at = del.caret;
  }
  const own = ownNeighbour(doc, sel.story, [at - 1], 'insert', author);
  const id = own ?? makeId();
  if (!own) ops.push(newSuggestionThread(id, author, now));
  const ins = insertText(doc, caretAt(sel.story, at), text, { ...pending, suggestion: { id, kind: 'insert' } });
  ops.push(ins.op);
  return { op: batch(ops), selection: ins.selection };
}

/**
 * Deleting in suggesting mode: the range is marked deleted, except the
 * person's own suggested text, which simply goes. `dir` says where the caret
 * ends: before the range (-1, Backspace) or after it (1, Delete).
 */
export function suggestDelete(doc: DocModel, sel: DocSelection, author: Reviewer, dir: 1 | -1, makeId: () => string = newId, now = Date.now()): Edit & { caret: number } {
  const story = doc.stories.get(sel.story);
  const { from, to: rawTo } = selectionRange(sel);
  // The story's last paragraph mark stays.
  const to = story ? Math.min(rawTo, story.length - 1) : from;
  if (!story || from >= to) return { op: NOOP, selection: sel, caret: from };
  const own = ownNeighbour(doc, sel.story, [from - 1, to], 'delete', author);
  const id = own ?? makeId();
  const marks: Op[] = [];
  const removes: [number, number][] = [];
  story.forEachRun(from, to, (start, end, styleId) => {
    const s = doc.textStyles.get(styleId).suggestion;
    if (s?.kind === 'insert' && doc.comments.get(s.id)?.author.id === author.id) removes.push([start, end]);
    else if (s?.kind !== 'delete') marks.push({ type: 'formatText', story: sel.story, at: start, runs: [[end - start, { suggestion: { id, kind: 'delete' } }]] });
  });
  const ops: Op[] = [];
  if (marks.length && !own) ops.push(newSuggestionThread(id, author, now));
  ops.push(...marks);
  // Own insertions go from the end, so earlier positions stay put.
  let removed = 0;
  for (const [a, b] of removes.reverse()) {
    ops.push({ type: 'delete', story: sel.story, from: a, to: b });
    removed += b - a;
  }
  const caret = dir < 0 ? from : to - removed;
  return { op: batch(ops), selection: caretAt(sel.story, caret), caret };
}

/** Backspace (or Delete) at the caret in suggesting mode: the character before (after) it. */
export function suggestDeleteChar(doc: DocModel, sel: DocSelection, author: Reviewer, dir: 1 | -1, makeId: () => string = newId, now = Date.now()): Edit {
  if (!isCollapsed(sel)) return suggestDelete(doc, sel, author, dir, makeId, now);
  const story = doc.stories.get(sel.story);
  if (!story) return { op: NOOP, selection: sel };
  const pos = sel.head;
  const other = nextGrapheme(story, pos, dir);
  if (other === pos) return { op: NOOP, selection: sel };
  // Stepping over text already marked deleted moves the caret instead.
  const range = dir < 0 ? { story: sel.story, anchor: other, head: pos } : { story: sel.story, anchor: pos, head: other };
  if (suggestionAt(doc, sel.story, Math.min(pos, other))?.kind === 'delete') return { op: NOOP, selection: caretAt(sel.story, other) };
  return suggestDelete(doc, range, author, dir, makeId, now);
}

/** Accepts (or rejects) a suggestion: the text stays or goes, the mark and its discussion go. */
export function resolveSuggestion(doc: DocModel, id: string, accept: boolean): Op {
  const ranges = suggestionRanges(doc, id);
  const ops: Op[] = [];
  // Marks first (positions unchanged), then deletions from the end of each story.
  const removals: SuggestionRange[] = [];
  for (const r of ranges) {
    const keep = (r.kind === 'insert') === accept || r.kind === 'format';
    if (keep) ops.push({ type: 'formatText', story: r.story, at: r.from, runs: [[r.to - r.from, { suggestion: null }]] });
    else removals.push(r);
  }
  removals.sort(laterFirst);
  for (const r of removals) {
    // Never the story's last paragraph mark (suggestions do not reach it, but a damaged file might).
    const to = Math.min(r.to, doc.stories.get(r.story)!.length - 1);
    if (to > r.from) ops.push({ type: 'delete', story: r.story, from: r.from, to });
  }
  if (doc.comments.has(id)) ops.push({ type: 'patchComments', remove: [id] });
  return batch(ops);
}

/** Every suggestion in the document, by id, in the order of the text. */
export function suggestionIds(doc: DocModel): string[] {
  return [...suggestionStarts(doc).keys()];
}

/** Ranges grouped by story, each story's from its end, so deleting one leaves the others' positions as they were. */
function laterFirst(a: SuggestionRange, b: SuggestionRange): number {
  if (a.story !== b.story) return a.story < b.story ? -1 : 1;
  return b.from - a.from;
}

/** Enter in suggesting mode: the paragraph splits, and the new paragraph mark is a suggested insertion. */
export function suggestSplit(doc: DocModel, sel: DocSelection, author: Reviewer, makeId: () => string = newId, now = Date.now()): Edit {
  const split = splitParagraph(doc, caretAt(sel.story, selectionRange(sel).from));
  // Enter in an empty list item ends the list: nothing is inserted to suggest.
  if (split.op.type === 'formatParagraphs') return split;
  return { op: batch([split.op, markInserted(doc, sel.story, split.selection.head - 1, split.selection.head, author, makeId, now)]), selection: split.selection };
}

/**
 * Marks text just inserted at [from, to) of a story (after a paste) as a
 * suggested insertion. Positions are those after the insertion; the
 * neighbour checked to carry on a suggestion is the character before `from`.
 */
export function markInserted(doc: DocModel, storyId: string, from: number, to: number, author: Reviewer, makeId: () => string = newId, now = Date.now()): Op {
  if (to <= from) return NOOP;
  const own = ownNeighbour(doc, storyId, [from - 1], 'insert', author);
  const id = own ?? makeId();
  const ops: Op[] = own ? [] : [newSuggestionThread(id, author, now)];
  ops.push({ type: 'formatText', story: storyId, at: from, runs: [[to - from, { suggestion: { id, kind: 'insert' } }]] });
  return batch(ops);
}
