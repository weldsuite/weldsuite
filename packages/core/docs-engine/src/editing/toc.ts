/**
 * Table of contents: one paragraph per heading, its text linked to a
 * bookmark on the heading, then a dotted tab and the page the heading is on
 * (a `pageRef` field, worked out at layout, so the numbers stay right while
 * the document changes). The table itself is covered by a bookmark whose id
 * starts with `toc:`, so it can be found again and rebuilt when headings
 * are added, renamed or removed.
 */

import { LINE_BREAK, OBJECT, PARA, TAB } from '../model/chars';
import type { Content } from '../model/content';
import { ContentBuilder } from '../model/builder';
import type { DocModel } from '../model/document';
import { newId } from '../model/ids';
import { BODY, type Anchor } from '../model/objects';
import type { ParaProps } from '../model/styles';
import { batch, NOOP, type Op } from '../ops/types';
import { paragraphAt } from './boundaries';
import { caretAt, selectionRange, type DocSelection, type Edit } from './commands';

export const TOC_PREFIX = 'toc:';
/** Heading levels a table of contents lists. */
const MAX_LEVEL = 3;
/** Indent per level below the first, points. */
const LEVEL_INDENT = 18;

export interface TocHeading {
  level: number;
  text: string;
  /** Range of the heading's text in the body. */
  from: number;
  to: number;
  /** A bookmark already on it, if any. */
  bookmark: string | null;
}

const HIDDEN = new RegExp(`[${LINE_BREAK}${OBJECT}${TAB}]+`, 'g');

/** The body's headings (levels 1–3) in order, outside any table of contents. */
export function tocHeadings(doc: DocModel): TocHeading[] {
  const body = doc.body;
  const marks: Anchor[] = [];
  const tocs: Anchor[] = [];
  for (const a of doc.anchors.values()) {
    if (a.story !== BODY || a.kind !== 'bookmark') continue;
    if (a.id.startsWith(TOC_PREFIX)) tocs.push(a);
    else marks.push(a);
  }
  const out: TocHeading[] = [];
  body.forEachAttr(0, body.length, (pos, attr) => {
    if (body.charAt(pos) !== PARA) return;
    const style = (attr as ParaProps).style;
    const level = style ? doc.styles.get(style)?.outline : undefined;
    if (!level || level > MAX_LEVEL) return;
    const from = body.lastIndexOf(PARA, pos - 1) + 1;
    if (tocs.some((t) => from >= t.from && from < t.to)) return;
    const text = body.text(from, pos).replace(HIDDEN, ' ').trim();
    // Typing at a heading's start pushes its bookmark along: any bookmark in the heading counts.
    const mark = marks.find((a) => a.from >= from && a.from <= pos);
    if (text) out.push({ level, text, from, to: pos, bookmark: mark?.id ?? null });
  });
  return out;
}

/** The id of the table of contents covering a body position, if any. */
export function tocAt(doc: DocModel, story: string, pos: number): string | null {
  if (story !== BODY) return null;
  for (const a of doc.anchors.values()) if (a.id.startsWith(TOC_PREFIX) && pos >= a.from && pos < a.to) return a.id;
  return null;
}

/** Every table of contents in the document. */
export function tocIds(doc: DocModel): string[] {
  return [...doc.anchors.values()].filter((a) => a.id.startsWith(TOC_PREFIX)).map((a) => a.id);
}

interface Built {
  content: Content;
  /** Bookmarks to put on headings that have none yet (positions before the change). */
  marks: Anchor[];
}

function build(doc: DocModel, emptyText: string, makeId: () => string): Built {
  const s = doc.props.section;
  const width = Math.max(72, s.pageWidth - s.marginLeft - s.marginRight);
  const b = new ContentBuilder(makeId);
  const marks: Anchor[] = [];
  const headings = tocHeadings(doc);
  if (!headings.length) b.addText(emptyText, { italic: true, color: '#5f6368' }).endParagraph();
  for (const h of headings) {
    let id = h.bookmark;
    if (!id) {
      id = makeId();
      marks.push({ id, kind: 'bookmark', story: BODY, from: h.from, to: h.to });
    }
    const indent = (h.level - 1) * LEVEL_INDENT;
    b.addText(h.text, { link: `#${id}` }).addText(TAB).addObject({ kind: 'field', field: 'pageRef', ref: id });
    const props: ParaProps = { tabs: [{ pos: width - indent, align: 'right', leader: 'dot' }], spaceAfter: 4 };
    if (indent) props.indentLeft = indent;
    b.endParagraph(props);
  }
  return { content: b.build(), marks };
}

/** Moves bookmarks recorded before a change at `at` (`removed` characters out, `added` in) to after it. */
function shifted(marks: Anchor[], at: number, removed: number, added: number): Anchor[] {
  return marks.map((m) => (m.from >= at ? { ...m, from: m.from - removed + added, to: m.to - removed + added } : m));
}

/**
 * Inserts a table of contents before the paragraph the caret is in (the
 * body only). `emptyText` is shown while the document has no headings.
 */
export function insertToc(doc: DocModel, sel: DocSelection, emptyText: string, makeId: () => string = newId): Edit {
  if (sel.story !== BODY) return { op: NOOP, selection: sel };
  const at = paragraphAt(doc.body, selectionRange(sel).from).start;
  const { content, marks } = build(doc, emptyText, makeId);
  const len = content.text.length;
  const toc: Anchor = { id: `${TOC_PREFIX}${makeId()}`, kind: 'bookmark', story: BODY, from: at, to: at + len };
  return {
    op: batch([{ type: 'insert', story: BODY, at, content }, { type: 'patchAnchors', set: [...shifted(marks, at, 0, len), toc] }]),
    selection: caretAt(BODY, at + len),
  };
}

/** Rebuilds a table of contents from the headings as they are now. */
export function updateToc(doc: DocModel, tocId: string, emptyText: string, makeId: () => string = newId): Op {
  const old = doc.anchors.get(tocId);
  if (!old || old.story !== BODY || old.to <= old.from) return NOOP;
  const { content, marks } = build(doc, emptyText, makeId);
  const len = content.text.length;
  const removed = old.to - old.from;
  return batch([
    { type: 'delete', story: BODY, from: old.from, to: old.to },
    { type: 'insert', story: BODY, at: old.from, content },
    { type: 'patchAnchors', set: [...shifted(marks, old.from, removed, len), { ...old, from: old.from, to: old.from + len }] },
  ]);
}
