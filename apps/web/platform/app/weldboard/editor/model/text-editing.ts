/**
 * Editing the text of one element: typing, deleting, moving the caret,
 * selecting and formatting. Every change is a text op, so two people in one
 * sticky merge by character; a run of typing is one undo step.
 */

import {
  caretRect,
  marksAt,
  sliceRich,
  verticalMove,
  type Marks,
  type MarksPatch,
  type Op,
  type RichText,
} from '@weldsuite/board-engine';
import type { BoardController } from './board-controller';

type MarkFlag = 'b' | 'i' | 'u' | 's';

/** Marks for the next typed character, set by Ctrl+B and friends on an empty selection. */
const pendingMarks = new WeakMap<BoardController, Marks>();

function range(c: BoardController): { from: number; to: number } | null {
  const e = c.editing;
  if (!e) return null;
  return { from: Math.min(e.anchor, e.head), to: Math.max(e.anchor, e.head) };
}

function textOf(c: BoardController): string {
  const id = c.editing?.id;
  return (id && c.board.get(id)?.text?.text) || '';
}

function richOf(c: BoardController): RichText {
  const id = c.editing?.id;
  return (id && c.board.get(id)?.text) || { text: '', marks: [] };
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const wordSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

function nextBoundary(text: string, pos: number, dir: 1 | -1, word: boolean): number {
  if (word && wordSegmenter) {
    const segs = [...wordSegmenter.segment(text)];
    if (dir > 0) {
      for (const s of segs) if (s.index > pos && (s.isWordLike || s.index + s.segment.length === text.length)) return s.index;
      for (const s of segs) if (s.index + s.segment.length > pos && s.isWordLike) return s.index + s.segment.length;
      return text.length;
    }
    let last = 0;
    for (const s of segs) {
      if (s.index >= pos) break;
      if (s.isWordLike) last = s.index;
    }
    return last;
  }
  if (segmenter) {
    if (dir > 0) {
      for (const s of segmenter.segment(text)) if (s.index > pos) return s.index;
      return text.length;
    }
    let prev = 0;
    for (const s of segmenter.segment(text)) {
      if (s.index >= pos) break;
      prev = s.index;
    }
    return prev;
  }
  return Math.max(0, Math.min(text.length, pos + dir));
}

function setCaret(c: BoardController, head: number, extend: boolean, goalX?: number): void {
  const e = c.editing;
  if (!e) return;
  c.editing = { id: e.id, anchor: extend ? e.anchor : head, head, goalX };
  pendingMarks.delete(c);
  c.changed();
}

function editOps(c: BoardController, from: number, to: number, insert: RichText | null): Op[] {
  const id = c.editing!.id;
  const ops: Op[] = [];
  if (to > from) ops.push({ type: 'deleteText', id, from, to });
  if (insert && insert.text.length) ops.push({ type: 'insertText', id, at: from, text: insert });
  return ops;
}

export function insertText(c: BoardController, text: string): void {
  const r = range(c);
  if (!r || c.readOnly) return;
  const clean = text.replace(/\r\n?/g, '\n');
  const pending = pendingMarks.get(c);
  const marks = pending ?? marksAt(richOf(c), r.from);
  // Links and mentions do not carry on into what is typed after them.
  delete marks.a;
  delete marks.m;
  const rich: RichText = { text: clean, marks: Object.keys(marks).length && clean.length ? [[clean.length, marks]] : [] };
  const id = c.editing!.id;
  if (c.apply({ type: 'batch', ops: editOps(c, r.from, r.to, rich) }, { gesture: `type:${id}` })) {
    const pos = r.from + clean.length;
    c.editing = { id, anchor: pos, head: pos };
    if (pending) pendingMarks.set(c, pending);
    c.changed();
  }
}

/** Inserts formatted text (a paste from another element). */
export function insertRichText(c: BoardController, rich: RichText): void {
  const r = range(c);
  if (!r || c.readOnly) return;
  const id = c.editing!.id;
  if (c.apply({ type: 'batch', ops: editOps(c, r.from, r.to, rich) })) {
    const pos = r.from + rich.text.length;
    c.editing = { id, anchor: pos, head: pos };
    c.changed();
  }
}

export function deleteBackward(c: BoardController, word = false): void {
  const r = range(c);
  if (!r || c.readOnly) return;
  const from = r.from < r.to ? r.from : nextBoundary(textOf(c), r.from, -1, word);
  if (from === r.to) return;
  const id = c.editing!.id;
  if (c.apply({ type: 'deleteText', id, from, to: r.to }, { gesture: `type:${id}` })) {
    c.editing = { id, anchor: from, head: from };
    c.changed();
  }
}

export function deleteForward(c: BoardController, word = false): void {
  const r = range(c);
  if (!r || c.readOnly) return;
  const to = r.from < r.to ? r.to : nextBoundary(textOf(c), r.to, 1, word);
  if (to === r.from) return;
  const id = c.editing!.id;
  if (c.apply({ type: 'deleteText', id, from: r.from, to }, { gesture: `type:${id}` })) {
    c.editing = { id, anchor: r.from, head: r.from };
    c.changed();
  }
}

export type CaretMove = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd' | 'start' | 'end';

export function moveCaret(c: BoardController, move: CaretMove, extend: boolean, word = false): void {
  const e = c.editing;
  if (!e) return;
  const text = textOf(c);
  const r = range(c)!;
  switch (move) {
    case 'left':
      if (!extend && r.from !== r.to) return setCaret(c, r.from, false);
      return setCaret(c, nextBoundary(text, e.head, -1, word), extend);
    case 'right':
      if (!extend && r.from !== r.to) return setCaret(c, r.to, false);
      return setCaret(c, nextBoundary(text, e.head, 1, word), extend);
    case 'start':
      return setCaret(c, 0, extend);
    case 'end':
      return setCaret(c, text.length, extend);
    default: {
      const t = c.editingLayout();
      if (!t) return;
      const lines = t.layout.lines;
      if (move === 'lineStart' || move === 'lineEnd') {
        const caret = caretRect(t.layout, e.head);
        const line = lines.find((l) => caret.y >= l.y && caret.y < l.y + l.height) ?? lines[0];
        if (!line) return;
        return setCaret(c, move === 'lineStart' ? line.start : line.end, extend);
      }
      const next = verticalMove(t.layout, e.head, move === 'up' ? -1 : 1, e.goalX);
      return setCaret(c, next.pos, extend, next.x);
    }
  }
}

export function selectAllText(c: BoardController): void {
  const e = c.editing;
  if (!e) return;
  c.editing = { id: e.id, anchor: 0, head: textOf(c).length };
  c.changed();
}

export function selectedText(c: BoardController): RichText | null {
  const r = range(c);
  if (!r || r.from === r.to) return null;
  return sliceRich(richOf(c), r.from, r.to);
}

/** Bold, italic, underline or strikethrough: on for the selection, or off when all of it already has it. */
export function toggleMark(c: BoardController, mark: MarkFlag): void {
  const r = range(c);
  if (!r || c.readOnly) return;
  const rich = richOf(c);
  if (r.from === r.to) {
    const current = pendingMarks.get(c) ?? marksAt(rich, r.from);
    const next = { ...current };
    if (next[mark]) delete next[mark];
    else next[mark] = true;
    pendingMarks.set(c, next);
    c.changed();
    return;
  }
  const slice = sliceRich(rich, r.from, r.to);
  const all = slice.marks.length > 0 && slice.marks.every(([, m]) => !!m[mark]);
  const patch: MarksPatch = { [mark]: all ? null : true };
  c.apply({ type: 'formatText', id: c.editing!.id, at: r.from, runs: [[r.to - r.from, patch]] });
}

/** Sets or clears a value mark (colour, highlight, link) on the selection. */
export function setMark(c: BoardController, mark: 'c' | 'h' | 'a', value: string | null): void {
  const r = range(c);
  if (!r || c.readOnly || r.from === r.to) return;
  c.apply({ type: 'formatText', id: c.editing!.id, at: r.from, runs: [[r.to - r.from, { [mark]: value }]] });
}

/** Whether the caret or the whole selection has a mark (for the toolbar's pressed state). */
export function hasMark(c: BoardController, mark: MarkFlag): boolean {
  const r = range(c);
  if (!r) return false;
  const rich = richOf(c);
  if (r.from === r.to) return !!(pendingMarks.get(c) ?? marksAt(rich, r.from))[mark];
  const slice = sliceRich(rich, r.from, r.to);
  return slice.marks.length > 0 && slice.marks.every(([, m]) => !!m[mark]);
}

/** Inserts a mention of a member as text carrying the mention mark. */
export function insertMention(c: BoardController, userId: string, name: string, replaceFrom?: number): void {
  const r = range(c);
  if (!r) return;
  const from = replaceFrom ?? r.from;
  const label = `@${name}`;
  const id = c.editing!.id;
  const ops: Op[] = editOps(c, from, r.to, { text: label, marks: [[label.length, { m: userId }]] });
  ops.push({ type: 'insertText', id, at: from + label.length, text: { text: ' ', marks: [] } });
  if (c.apply({ type: 'batch', ops })) {
    const pos = from + label.length + 1;
    c.editing = { id, anchor: pos, head: pos };
    c.changed();
  }
}
