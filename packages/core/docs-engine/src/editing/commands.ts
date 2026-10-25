/**
 * Editing commands: what typing, deleting, Enter, formatting and pasting do
 * to a document, as ops. Pure functions of the document and a selection,
 * so the editor, tests and agent tools all edit the same way.
 *
 * Paragraph merging follows Google Docs: the merged paragraph keeps the
 * first paragraph's formatting.
 */

import { LINE_BREAK, OBJECT, PARA, cleanStoryText } from '../model/chars';
import type { Fragment } from '../model/builder';
import type { Content } from '../model/content';
import { bulletList, checkList, numberedList } from '../model/defaults';
import type { DocModel } from '../model/document';
import { freshIds, newId } from '../model/ids';
import type { ObjectData } from '../model/objects';
import { resolveParagraph, resolveText } from '../model/resolve';
import type { Story } from '../model/story';
import {
  applyPatch,
  isEmptyObject,
  replacingPatch,
  type ListDef,
  type ParaPatch,
  type ParaProps,
  type TextStyle,
  type TextStylePatch,
} from '../model/styles';
import { batch, NOOP, type Op } from '../ops/types';
import { nextGrapheme, nextWord, paragraphAt } from './boundaries';

/** A selection in one story: `anchor` where it started, `head` where the caret is. */
export interface DocSelection {
  story: string;
  anchor: number;
  head: number;
}

export function caretAt(story: string, pos: number): DocSelection {
  return { story, anchor: pos, head: pos };
}

export function selectionRange(sel: DocSelection): { from: number; to: number } {
  return sel.anchor <= sel.head ? { from: sel.anchor, to: sel.head } : { from: sel.head, to: sel.anchor };
}

export function isCollapsed(sel: DocSelection): boolean {
  return sel.anchor === sel.head;
}

/** An edit: the op, and where the selection goes after it. */
export interface Edit {
  op: Op;
  selection: DocSelection;
}

function storyOf(doc: DocModel, sel: DocSelection): Story {
  const story = doc.stories.get(sel.story);
  if (!story) throw new Error(`No story ${sel.story}`);
  return story;
}

/** Keeps a range inside the story, before its final paragraph mark. */
function clampRange(story: Story, from: number, to: number): { from: number; to: number } {
  const max = story.length - 1;
  return { from: Math.max(0, Math.min(from, max)), to: Math.max(0, Math.min(to, max)) };
}

// ---------------------------------------------------------------- styles at a position

/**
 * The direct style new text typed at `pos` gets: that of the character
 * before it in the same paragraph (or the paragraph mark in an empty one).
 * A link does not grow past its end.
 */
export function styleForInsert(doc: DocModel, storyId: string, pos: number): TextStyle {
  const story = doc.stories.get(storyId);
  if (!story) return {};
  const before = pos > 0 ? story.charAt(pos - 1) : PARA;
  const source = before !== PARA && before !== OBJECT ? pos - 1 : pos;
  const style = { ...doc.textStyles.get(story.styleAt(source)) };
  if (style.link && source === pos - 1) {
    const next = doc.textStyles.get(story.styleAt(pos));
    if (next.link !== style.link) delete style.link;
  }
  delete style.suggestion;
  return style;
}

/** Paragraph properties of the paragraph holding `pos`. */
export function paragraphProps(doc: DocModel, storyId: string, pos: number): ParaProps {
  const story = doc.stories.get(storyId);
  if (!story) return {};
  const { end } = paragraphAt(story, pos);
  return (story.attrAt(end) as ParaProps | undefined) ?? {};
}

/** The look at the caret (or the selection start): named style resolved, for the toolbar. */
export function resolvedStyleAt(doc: DocModel, sel: DocSelection, pending: TextStyle | null): TextStyle & { font: string; size: number } {
  const { from } = selectionRange(sel);
  const para = paragraphProps(doc, sel.story, from);
  const direct = isCollapsed(sel) ? styleForInsert(doc, sel.story, from) : { ...doc.textStyles.get(storyOf(doc, sel).styleAt(from)) };
  return resolveText(doc, para, { ...direct, ...pending });
}

/** True when every character of the selection has `key` set (resolved through named styles). */
export function allHave(doc: DocModel, sel: DocSelection, key: 'bold' | 'italic' | 'underline' | 'strike' | 'smallCaps' | 'allCaps', pending: TextStyle | null): boolean {
  if (isCollapsed(sel)) return !!resolvedStyleAt(doc, sel, pending)[key];
  const story = storyOf(doc, sel);
  const { from, to } = selectionRange(sel);
  let all = true;
  let any = false;
  story.forEachRun(from, to, (s, e, id) => {
    const text = story.text(s, e);
    if (text === PARA.repeat(e - s)) return;
    any = true;
    const para = paragraphProps(doc, sel.story, s);
    if (!resolveText(doc, para, doc.textStyles.get(id))[key]) all = false;
  });
  return any && all;
}

// ---------------------------------------------------------------- typing and deleting

/** Deletes the selection (if any), returning the op and where the caret lands. */
export function deleteSelection(doc: DocModel, sel: DocSelection): Edit {
  const story = storyOf(doc, sel);
  const { from, to } = clampRange(story, selectionRange(sel).from, selectionRange(sel).to);
  if (from === to) return { op: NOOP, selection: caretAt(sel.story, from) };
  return { op: deleteKeepingFirst(doc, story, sel.story, from, to), selection: caretAt(sel.story, from) };
}

/**
 * Deletes [from, to). When that removes paragraph marks, the paragraph the
 * deletion started in keeps its properties (the surviving mark gets them).
 */
function deleteKeepingFirst(doc: DocModel, story: Story, storyId: string, from: number, to: number): Op {
  const del: Op = { type: 'delete', story: storyId, from, to };
  const firstMark = story.indexOf(PARA, from);
  if (firstMark < 0 || firstMark >= to) return del;
  const survivor = story.indexOf(PARA, to);
  if (survivor < 0) return del;
  const keep = (story.attrAt(firstMark) as ParaProps | undefined) ?? {};
  const now = (story.attrAt(survivor) as ParaProps | undefined) ?? {};
  const patch = replacingPatch(now, keep);
  const ops: Op[] = [del];
  if (!isEmptyObject(patch)) ops.push({ type: 'formatParagraphs', story: storyId, at: survivor - (to - from), runs: [[1, patch]] });
  // The mark's own character style (an empty paragraph's typing style) follows too.
  const markStyle = doc.textStyles.get(story.styleAt(firstMark));
  const survivorStyle = doc.textStyles.get(story.styleAt(survivor));
  const textPatch = replacingPatch(survivorStyle, markStyle);
  if (!isEmptyObject(textPatch)) ops.push({ type: 'formatText', story: storyId, at: survivor - (to - from), runs: [[1, textPatch]] });
  return batch(ops);
}

/**
 * Types `text` over the selection. Newlines become paragraph breaks, and the
 * paragraphs they make keep the current paragraph's properties.
 */
export function insertText(doc: DocModel, sel: DocSelection, text: string, pending: TextStyle | null = null): Edit {
  const clean = cleanStoryText(text);
  if (!clean) return { op: NOOP, selection: sel };
  const { from } = selectionRange(sel);
  const del = deleteSelection(doc, sel);
  const at = del.selection.head;
  const style: TextStyle = { ...styleForInsert(doc, sel.story, from), ...pending };
  for (const k of Object.keys(style) as (keyof TextStyle)[]) if (style[k] === undefined || style[k] === null) delete style[k];
  const content: Content = { text: clean };
  if (!isEmptyObject(style)) content.runs = [[clean.length, style]];
  if (clean.includes(PARA)) {
    // A heading's link target stays with the original paragraph.
    const props: ParaProps = { ...paragraphProps(doc, sel.story, from) };
    delete props.anchorId;
    if (!isEmptyObject(props)) {
      const paras: [number, ParaProps][] = [];
      for (let i = clean.indexOf(PARA); i >= 0; i = clean.indexOf(PARA, i + 1)) paras.push([i, props]);
      content.paras = paras;
    }
  }
  return { op: batch([del.op, { type: 'insert', story: sel.story, at, content }]), selection: caretAt(sel.story, at + clean.length) };
}

export type DeleteUnit = 'char' | 'word';

/**
 * Backspace. At the start of a list item or indented paragraph it first
 * removes the bullet or indent (as Google Docs does); before a table or
 * image it selects the object rather than deleting it outright.
 */
export function deleteBackward(doc: DocModel, sel: DocSelection, unit: DeleteUnit = 'char'): Edit {
  if (!isCollapsed(sel)) return deleteSelection(doc, sel);
  const story = storyOf(doc, sel);
  const pos = sel.head;
  if (pos <= 0) {
    return paragraphStartBackspace(doc, sel) ?? { op: NOOP, selection: sel };
  }
  const prev = story.charAt(pos - 1);
  const { start } = paragraphAt(story, pos);
  if (pos === start) {
    const outdent = paragraphStartBackspace(doc, sel);
    if (outdent) return outdent;
    // Merging into a paragraph that holds only a table: leave the table alone.
    if (story.charAt(pos - 2) === OBJECT && (story.attrAt(pos - 2) as ObjectData | undefined)?.kind === 'table') {
      return { op: NOOP, selection: { story: sel.story, anchor: pos - 2, head: pos - 1 } };
    }
  }
  if (prev === OBJECT) {
    const obj = story.attrAt(pos - 1) as ObjectData | undefined;
    if (obj?.kind === 'table' || obj?.kind === 'image') return { op: NOOP, selection: { story: sel.story, anchor: pos, head: pos - 1 } };
  }
  const from = unit === 'word' ? nextWord(story, pos, -1) : nextGrapheme(story, pos, -1);
  return { op: deleteKeepingFirst(doc, story, sel.story, from, pos), selection: caretAt(sel.story, from) };
}

/** Removes a list or indent at a paragraph's start; null when there is none. */
function paragraphStartBackspace(doc: DocModel, sel: DocSelection): Edit | null {
  const story = storyOf(doc, sel);
  const { start, end } = paragraphAt(story, sel.head);
  if (sel.head !== start) return null;
  const props = (story.attrAt(end) as ParaProps | undefined) ?? {};
  if (props.list) {
    return { op: { type: 'formatParagraphs', story: sel.story, at: end, runs: [[1, { list: null, checked: null }]] }, selection: sel };
  }
  if ((props.indentLeft ?? 0) > 0 || (props.indentFirst ?? 0) > 0) {
    const patch: ParaPatch = (props.indentFirst ?? 0) > 0 ? { indentFirst: null } : { indentLeft: Math.max(0, (props.indentLeft ?? 0) - 36) || null };
    return { op: { type: 'formatParagraphs', story: sel.story, at: end, runs: [[1, patch]] }, selection: sel };
  }
  return null;
}

/** Delete (forward). At a paragraph's end it joins the next paragraph into this one. */
export function deleteForward(doc: DocModel, sel: DocSelection, unit: DeleteUnit = 'char'): Edit {
  if (!isCollapsed(sel)) return deleteSelection(doc, sel);
  const story = storyOf(doc, sel);
  const pos = sel.head;
  if (pos >= story.length - 1) return { op: NOOP, selection: sel };
  const next = story.charAt(pos);
  if (next === OBJECT) {
    const obj = story.attrAt(pos) as ObjectData | undefined;
    if (obj?.kind === 'table' || obj?.kind === 'image') return { op: NOOP, selection: { story: sel.story, anchor: pos, head: pos + 1 } };
  }
  const to = Math.min(story.length - 1, unit === 'word' ? nextWord(story, pos, 1) : nextGrapheme(story, pos, 1));
  if (to <= pos) return { op: NOOP, selection: sel };
  return { op: deleteKeepingFirst(doc, story, sel.story, pos, to), selection: caretAt(sel.story, pos) };
}

// ---------------------------------------------------------------- paragraphs

/**
 * Enter: splits the paragraph. The first half keeps the paragraph's
 * properties; at a heading's end the new paragraph takes the style's
 * `next` style. Enter in an empty list item ends the list instead.
 */
export function splitParagraph(doc: DocModel, sel: DocSelection): Edit {
  const story = storyOf(doc, sel);
  const range = selectionRange(sel);
  const { start, end } = paragraphAt(story, range.from);
  const props = (story.attrAt(end) as ParaProps | undefined) ?? {};
  if (isCollapsed(sel) && props.list && start === end) {
    return { op: { type: 'formatParagraphs', story: sel.story, at: end, runs: [[1, { list: null, checked: null }]] }, selection: sel };
  }
  const del = deleteSelection(doc, sel);
  const at = del.selection.head;
  // Position of the (old) mark after the deletion.
  const markAfterDelete = end - (range.to > end ? 0 : range.to - range.from);
  const ops: Op[] = [del.op, { type: 'insert', story: sel.story, at, content: firstHalfMark(doc, story, end, props) }];
  // The second half (the old mark, now one further on).
  const second = secondHalfPatch(doc, props, at === markAfterDelete);
  if (!isEmptyObject(second)) ops.push({ type: 'formatParagraphs', story: sel.story, at: markAfterDelete + 1, runs: [[1, second]] });
  return { op: batch(ops), selection: caretAt(sel.story, at + 1) };
}

/** The new mark ending the first half: the paragraph's properties and its mark's character style. */
function firstHalfMark(doc: DocModel, story: Story, end: number, props: ParaProps): Content {
  const markStyle = doc.textStyles.get(story.styleAt(end));
  const first: ParaProps = { ...props };
  const content: Content = { text: PARA };
  if (!isEmptyObject(first)) content.paras = [[0, first]];
  if (!isEmptyObject(markStyle)) content.runs = [[1, markStyle]];
  return content;
}

/**
 * What the second half drops: the heading's link target and the tick; split
 * at its end, a heading's style gives way to its `next` style, and a page
 * break before it stays with the first half.
 */
function secondHalfPatch(doc: DocModel, props: ParaProps, atEnd: boolean): ParaPatch {
  const second: ParaPatch = {};
  if (props.anchorId) second.anchorId = null;
  if (props.checked) second.checked = null;
  if (!atEnd) return second;
  const named = props.style ? doc.styles.get(props.style) : undefined;
  if (named?.next && named.next !== props.style) second.style = named.next === 'normal' ? null : named.next;
  if (props.pageBreakBefore) second.pageBreakBefore = null;
  return second;
}

export function insertLineBreak(doc: DocModel, sel: DocSelection): Edit {
  const del = deleteSelection(doc, sel);
  const at = del.selection.head;
  const style = styleForInsert(doc, sel.story, selectionRange(sel).from);
  const content: Content = isEmptyObject(style) ? { text: LINE_BREAK } : { text: LINE_BREAK, runs: [[1, style]] };
  return { op: batch([del.op, { type: 'insert', story: sel.story, at, content }]), selection: caretAt(sel.story, at + 1) };
}

/** The paragraph marks covered by a selection: [first paragraph start, last mark + 1). */
export function paragraphSpan(doc: DocModel, sel: DocSelection): { from: number; to: number } {
  const story = storyOf(doc, sel);
  const { from, to } = selectionRange(sel);
  const a = paragraphAt(story, from);
  const b = paragraphAt(story, Math.max(from, to - (to > from && story.charAt(to - 1) === PARA ? 1 : 0)));
  return { from: a.start, to: b.end + 1 };
}

/** Patches the properties of every paragraph the selection touches. */
export function formatParagraphs(doc: DocModel, sel: DocSelection, patch: ParaPatch): Op {
  const { from, to } = paragraphSpan(doc, sel);
  return { type: 'formatParagraphs', story: sel.story, at: from, runs: [[to - from, patch]] };
}

/** Every paragraph's properties in the selection, in order. */
export function selectedParagraphs(doc: DocModel, sel: DocSelection): { mark: number; props: ParaProps }[] {
  const story = storyOf(doc, sel);
  const { from, to } = paragraphSpan(doc, sel);
  const out: { mark: number; props: ParaProps }[] = [];
  for (let p = story.indexOf(PARA, from); p >= 0 && p < to; p = story.indexOf(PARA, p + 1)) {
    out.push({ mark: p, props: (story.attrAt(p) as ParaProps | undefined) ?? {} });
  }
  return out;
}

export type ListKind = 'bullet' | 'numbered' | 'check';

const LIST_TEMPLATES: Record<ListKind, () => ListDef> = { bullet: bulletList, numbered: numberedList, check: checkList };

function listKindOf(doc: DocModel, id: string): ListKind | null {
  const def = doc.lists.get(id);
  const f = def?.levels[0]?.format;
  if (!f) return null;
  if (f === 'bullet' || f === 'check') return f;
  return 'numbered';
}

/**
 * Turns the selected paragraphs into a list of `kind`, or out of one when
 * they all already are. A list right before the selection of the same kind
 * is continued; otherwise a new list starts (numbering from 1).
 */
export function toggleList(doc: DocModel, sel: DocSelection, kind: ListKind, makeId: () => string = newId): Op {
  const paras = selectedParagraphs(doc, sel);
  if (paras.length && paras.every((p) => p.props.list && listKindOf(doc, p.props.list.id) === kind)) {
    return formatParagraphs(doc, sel, { list: null, checked: null });
  }
  const story = storyOf(doc, sel);
  const { from } = paragraphSpan(doc, sel);
  let listId: string | null = null;
  if (from > 0) {
    const prev = (story.attrAt(from - 1) as ParaProps | undefined)?.list;
    if (prev && listKindOf(doc, prev.id) === kind) listId = prev.id;
  }
  const ops: Op[] = [];
  if (!listId) {
    listId = makeId();
    ops.push({ type: 'patchLists', set: { [listId]: LIST_TEMPLATES[kind]() } });
  }
  const runs: [number, ParaPatch | null][] = [];
  let pos = from;
  for (const p of paras) {
    runs.push([p.mark + 1 - pos, { list: { id: listId, level: p.props.list?.level ?? 0 }, indentLeft: null, indentFirst: null, ...(kind === 'check' ? {} : { checked: null }) }]);
    pos = p.mark + 1;
  }
  ops.push({ type: 'formatParagraphs', story: sel.story, at: from, runs });
  return batch(ops);
}

/** Tab / Shift+Tab on paragraphs: list items change level, others their left indent. */
export function indent(doc: DocModel, sel: DocSelection, delta: 1 | -1): Op {
  const paras = selectedParagraphs(doc, sel);
  const { from } = paragraphSpan(doc, sel);
  const runs: [number, ParaPatch | null][] = [];
  let pos = from;
  for (const p of paras) {
    let patch: ParaPatch;
    if (p.props.list) patch = { list: { id: p.props.list.id, level: Math.max(0, Math.min(8, p.props.list.level + delta)) } };
    else {
      const left = Math.max(0, (p.props.indentLeft ?? 0) + 36 * delta);
      patch = { indentLeft: left || null };
    }
    runs.push([p.mark + 1 - pos, patch]);
    pos = p.mark + 1;
  }
  return { type: 'formatParagraphs', story: sel.story, at: from, runs };
}

/** Ticks or unticks a checklist item. */
export function toggleChecked(doc: DocModel, storyId: string, mark: number): Op {
  const story = doc.stories.get(storyId);
  const props = (story?.attrAt(mark) as ParaProps | undefined) ?? {};
  return { type: 'formatParagraphs', story: storyId, at: mark, runs: [[1, { checked: props.checked ? null : true }]] };
}

// ---------------------------------------------------------------- character formatting

/** Patches the character style of the selection (nothing for a caret: that is the pending style's job). */
export function formatText(sel: DocSelection, patch: TextStylePatch): Op {
  const { from, to } = selectionRange(sel);
  if (from === to) return NOOP;
  return { type: 'formatText', story: sel.story, at: from, runs: [[to - from, patch]] };
}

const TEXT_KEYS: (keyof TextStyle)[] = ['font', 'size', 'bold', 'italic', 'underline', 'strike', 'color', 'highlight', 'script', 'smallCaps', 'allCaps', 'spacing'];

/** Removes direct formatting (links and suggestions stay) and paragraph overrides (style and lists stay). */
export function clearFormatting(doc: DocModel, sel: DocSelection): Op {
  const ops: Op[] = [];
  const { from, to } = selectionRange(sel);
  if (to > from) ops.push(formatText(sel, Object.fromEntries(TEXT_KEYS.map((k) => [k, null])) as TextStylePatch));
  const keep = new Set(['style', 'list', 'checked', 'anchorId']);
  const paraPatch: ParaPatch = {};
  for (const p of selectedParagraphs(doc, sel)) for (const k of Object.keys(p.props)) if (!keep.has(k)) (paraPatch as Record<string, null>)[k] = null;
  if (!isEmptyObject(paraPatch)) ops.push(formatParagraphs(doc, sel, paraPatch));
  return batch(ops);
}

/** Makes the selection a link (with the usual blue underline), or changes the link it is in. */
export function setLink(doc: DocModel, sel: DocSelection, url: string, text?: string): Edit {
  const style: TextStylePatch = { link: url, color: '#1155cc', underline: true };
  if (isCollapsed(sel) || text !== undefined) {
    const label = text ?? url;
    const del = deleteSelection(doc, sel);
    const base = applyPatch(styleForInsert(doc, sel.story, selectionRange(sel).from), style) as TextStyle;
    const at = del.selection.head;
    return {
      op: batch([del.op, { type: 'insert', story: sel.story, at, content: { text: cleanStoryText(label), runs: [[label.length, base]] } }]),
      selection: caretAt(sel.story, at + cleanStoryText(label).length),
    };
  }
  return { op: formatText(sel, style), selection: sel };
}

/** The link range around a position, if it is in one. */
export function linkAt(doc: DocModel, storyId: string, pos: number): { from: number; to: number; url: string } | null {
  const story = doc.stories.get(storyId);
  if (!story) return null;
  const at = (p: number) => (p >= 0 && p < story.length ? doc.textStyles.get(story.styleAt(p)).link : undefined);
  const url = at(pos) ?? at(pos - 1);
  if (!url) return null;
  let from = at(pos) === url ? pos : pos - 1;
  let to = from;
  while (from > 0 && at(from - 1) === url) from--;
  while (to < story.length && at(to) === url) to++;
  return { from, to, url };
}

export function removeLink(doc: DocModel, storyId: string, pos: number): Op {
  const link = linkAt(doc, storyId, pos);
  if (!link) return NOOP;
  return { type: 'formatText', story: storyId, at: link.from, runs: [[link.to - link.from, { link: null, color: null, underline: null }]] };
}

// ---------------------------------------------------------------- objects and paste

/** Inserts an object (page break, rule, image, field, chip) at the selection. */
export function insertObject(doc: DocModel, sel: DocSelection, data: ObjectData, ownLine = false): Edit {
  const del = deleteSelection(doc, sel);
  const story = storyOf(doc, sel);
  const at = del.selection.head;
  const style = styleForInsert(doc, sel.story, selectionRange(sel).from);
  const atParaStart = at === 0 || story.charAt(selectionRange(sel).from - 1) === PARA;
  let text = OBJECT;
  let offset = 0;
  if (ownLine) {
    if (!atParaStart) {
      text = PARA + text;
      offset = 1;
    }
    text += PARA;
  }
  const content: Content = { text, objects: [[offset, data]] };
  if (!isEmptyObject(style)) content.runs = [[text.length, style]];
  if (ownLine) {
    const props = paragraphProps(doc, sel.story, selectionRange(sel).from);
    const paras: [number, ParaProps][] = [];
    if (offset) paras.push([0, props]);
    content.paras = paras;
  }
  return { op: batch([del.op, { type: 'insert', story: sel.story, at, content }]), selection: caretAt(sel.story, at + text.length) };
}

/**
 * Pastes a fragment over the selection, with fresh ids for what it creates.
 * A fragment that is one plain paragraph pastes inline (its mark dropped),
 * so copying a few words does not split the paragraph pasted into.
 */
export function insertFragment(doc: DocModel, sel: DocSelection, fragment: Fragment, makeId: () => string = newId): Edit {
  let content = inlineIfOneParagraph(freshIds(fragment.content, makeId));
  if (!content.text) return { op: NOOP, selection: sel };
  // Lists get new ids too, so pasting twice makes two lists.
  const ops: Op[] = [];
  const { lists, renamed } = freshLists(doc, fragment, makeId);
  content = renameLists(content, renamed);
  if (Object.keys(lists).length) ops.push({ type: 'patchLists', set: lists });
  const del = deleteSelection(doc, sel);
  ops.push(del.op);
  const at = del.selection.head;
  // Plain text pasted inline takes the formatting where it lands.
  if (!content.runs?.length && !content.text.includes(PARA)) {
    const style = styleForInsert(doc, sel.story, selectionRange(sel).from);
    if (!isEmptyObject(style)) content = { ...content, runs: [[content.text.length, style]] };
  }
  ops.push({ type: 'insert', story: sel.story, at, content });
  return { op: batch(ops), selection: caretAt(sel.story, at + content.text.length) };
}

/** Content that is one plain paragraph loses its mark, so it pastes inline. */
function inlineIfOneParagraph(content: Content): Content {
  const paraCount = content.text.split(PARA).length - 1;
  const lastProps = content.paras?.find(([o]) => o === content.text.length - 1)?.[1];
  const plainMark = !lastProps || isEmptyObject(lastProps);
  if (!content.text.endsWith(PARA) || paraCount !== 1 || !plainMark || content.text.includes(OBJECT)) return content;
  const inline: Content = { ...content, text: content.text.slice(0, -1) };
  delete inline.paras;
  if (inline.runs) inline.runs = trimRuns(inline.runs, inline.text.length);
  return inline;
}

/** The fragment's lists under ids not yet used in `doc`, and which id became which. */
function freshLists(doc: DocModel, fragment: Fragment, makeId: () => string): { lists: Record<string, ListDef>; renamed: Map<string, string> } {
  const renamed = new Map<string, string>();
  const lists: Record<string, ListDef> = {};
  for (const [id, def] of Object.entries(fragment.lists ?? {})) {
    const fresh = doc.lists.has(id) ? makeId() : id;
    renamed.set(id, fresh);
    lists[fresh] = def;
  }
  return { lists, renamed };
}

/** Points the content's list paragraphs at their lists' new ids. */
function renameLists(content: Content, renamed: Map<string, string>): Content {
  if (!content.paras || !renamed.size) return content;
  return {
    ...content,
    paras: content.paras.map(([o, p]) => [o, p.list && renamed.has(p.list.id) ? { ...p, list: { ...p.list, id: renamed.get(p.list.id)! } } : p]),
  };
}

function trimRuns(runs: [number, TextStyle][], length: number): [number, TextStyle][] {
  const out: [number, TextStyle][] = [];
  let n = 0;
  for (const [len, style] of runs) {
    if (n >= length) break;
    const take = Math.min(len, length - n);
    out.push([take, style]);
    n += take;
  }
  return out;
}

/** Replaces [from, to) of a story with text in the style of the first replaced character. */
export function replaceRange(doc: DocModel, storyId: string, from: number, to: number, text: string): Op {
  const story = doc.stories.get(storyId);
  if (!story) return NOOP;
  const style = doc.textStyles.get(story.styleAt(from));
  const clean = cleanStoryText(text).replace(new RegExp(PARA, 'g'), ' ');
  const ops: Op[] = [];
  if (to > from) ops.push({ type: 'delete', story: storyId, from, to });
  if (clean) ops.push({ type: 'insert', story: storyId, at: from, content: isEmptyObject(style) ? { text: clean } : { text: clean, runs: [[clean.length, style]] } });
  return batch(ops);
}

/** Named style of every selected paragraph, or null when they differ. */
export function commonParagraphStyle(doc: DocModel, sel: DocSelection): string | null {
  const styles = new Set(selectedParagraphs(doc, sel).map((p) => p.props.style ?? 'normal'));
  return styles.size === 1 ? [...styles][0]! : null;
}

/** Resolved paragraph properties at the selection start (for the toolbar and ruler). */
export function resolvedParagraphAt(doc: DocModel, sel: DocSelection): ParaProps {
  return resolveParagraph(doc, paragraphProps(doc, sel.story, selectionRange(sel).from));
}
