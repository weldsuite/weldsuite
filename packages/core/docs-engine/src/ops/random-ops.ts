/**
 * Random valid ops against a document, for the fuzz tests (inverse
 * exactness, convergence). Not exported from the package.
 */

import { OBJECT, PARA } from '../model/chars';
import type { Content } from '../model/content';
import type { DocModel } from '../model/document';
import type { Story } from '../model/story';
import { BODY, cellStoryId, footnoteStoryId, headerStoryId, FINAL_SECTION, type DocComment, type ObjectData } from '../model/objects';
import type { Op } from './types';
import { validateOp } from './validate';

const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'é', '😀', 'tab\there', 'a', 'b'];

export function randomOp(doc: DocModel, random: () => number, makeId: () => string): Op | null {
  for (let attempt = 0; attempt < 20; attempt++) {
    const op = attemptOp(doc, random, makeId);
    if (op && validateOp(doc, op) === null) return op;
  }
  return null;
}

function pick<T>(random: () => number, items: T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function randomStory(doc: DocModel, random: () => number): string {
  if (random() < 0.6) return BODY;
  return pick(random, [...doc.stories.keys()]);
}

function randomText(random: () => number): Content {
  let text = '';
  const paras: [number, { align: 'center' }][] = [];
  const n = 1 + Math.floor(random() * 4);
  for (let i = 0; i < n; i++) {
    text += pick(random, WORDS);
    if (random() < 0.25) {
      if (random() < 0.5) paras.push([text.length, { align: 'center' }]);
      text += PARA;
    } else text += ' ';
  }
  const content: Content = { text };
  if (paras.length) content.paras = paras;
  if (random() < 0.3) content.runs = [[text.length, { bold: true }]];
  return content;
}

function objectContent(data: ObjectData, extra: Partial<Content> = {}): Content {
  return { text: OBJECT + PARA, objects: [[0, data]], ...extra };
}

/** What one attempt works with: the story it picked and the random sources. */
interface Gen {
  doc: DocModel;
  random: () => number;
  makeId: () => string;
  storyId: string;
  story: Story;
  len: number;
  /** A position before the story's final mark: [0, len-1]. */
  pos: () => number;
}

/**
 * One random op. `r` picks the kind; the helpers draw their further random
 * numbers in a fixed order, so a seeded run always produces the same ops.
 */
function attemptOp(doc: DocModel, random: () => number, makeId: () => string): Op | null {
  const storyId = randomStory(doc, random);
  const story = doc.stories.get(storyId)!;
  const len = story.length;
  const g: Gen = { doc, random, makeId, storyId, story, len, pos: () => Math.floor(random() * len) };
  const r = random();
  if (r < 0.39) return insertOp(g, r);
  if (r < 0.75) return editOp(g, r);
  if (r < 0.9) return tableOp(g);
  return docOp(g, r);
}

/** Inserts text (r < 0.3), an image, a table or a footnote. */
function insertOp(g: Gen, r: number): Op {
  const { random, makeId, storyId } = g;
  if (r < 0.3) return { type: 'insert', story: storyId, at: g.pos(), content: randomText(random) };
  if (r < 0.33) {
    return {
      type: 'insert',
      story: storyId,
      at: g.pos(),
      content: objectContent({ kind: 'image', id: makeId(), src: 'https://example.com/a.png', width: 100, height: 50 }),
    };
  }
  if (r < 0.37) {
    const id = makeId();
    const rows = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ id: makeId() }));
    const cols = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ id: makeId(), width: 100 }));
    const stories: Record<string, Content> = {};
    stories[cellStoryId(id, rows[0]!.id, cols[0]!.id)] = { text: `cell${PARA}` };
    return { type: 'insert', story: storyId, at: g.pos(), content: objectContent({ kind: 'table', id }, { tables: { [id]: { rows, cols } }, stories }) };
  }
  const id = makeId();
  return { type: 'insert', story: storyId, at: g.pos(), content: objectContent({ kind: 'footnote', id }, { stories: { [footnoteStoryId(id)]: { text: `note${PARA}` } } }) };
}

/** Deletes (r < 0.58), formats text or paragraphs, or patches an image. */
function editOp(g: Gen, r: number): Op | null {
  const { random, storyId, len } = g;
  if (r < 0.58) {
    if (len <= 1) return null;
    const from = Math.floor(random() * (len - 1));
    const to = Math.min(len - 1, from + 1 + Math.floor(random() * 12));
    return { type: 'delete', story: storyId, from, to };
  }
  if (r < 0.66) return formatTextOp(g);
  if (r < 0.72) {
    const at = g.pos();
    const length = Math.min(len - at, 1 + Math.floor(random() * 20));
    const patch = random() < 0.5 ? { align: 'right', style: 'heading2' } : { align: null };
    return { type: 'formatParagraphs', story: storyId, at, runs: [[length, patch]] } as Op;
  }
  return setImageOp(g);
}

function formatTextOp(g: Gen): Op {
  const { random, storyId, len } = g;
  const at = g.pos();
  const a = 1 + Math.floor(random() * Math.max(1, len - at));
  const patch = random() < 0.5 ? { italic: true, color: '#ff0000' } : { italic: null };
  const runs: [number, Record<string, unknown> | null][] = [[Math.min(a, len - at), patch]];
  if (random() < 0.3 && at + a < len) runs.push([1, null], [Math.max(0, Math.min(2, len - at - a - 1)), { underline: true }]);
  return { type: 'formatText', story: storyId, at, runs } as Op;
}

function setImageOp(g: Gen): Op | null {
  const { random, storyId, story, len } = g;
  const images: number[] = [];
  story.forEachAttr(0, len, (p, a) => {
    if ((a as ObjectData).kind === 'image') images.push(p);
  });
  if (!images.length) return null;
  const at = pick(random, images);
  const width = 10 + Math.floor(random() * 200);
  return { type: 'setObject', story: storyId, at, patch: { width, alt: random() < 0.5 ? 'pic' : null } };
}

/** An op on a random table: rows and columns, cells, or the table itself. */
function tableOp(g: Gen): Op | null {
  const { doc, random } = g;
  const tables = [...doc.tables.keys()];
  if (!tables.length) return null;
  const tableId = pick(random, tables);
  const table = doc.tables.get(tableId)!;
  const t = random();
  const axis = random() < 0.5 ? 'row' : 'col';
  if (t < 0.5) return dimsOp(g, tableId, axis, axis === 'row' ? table.rows : table.cols, t);
  if (!table.rows.length || !table.cols.length) return null;
  const row = pick(random, table.rows);
  const col = pick(random, table.cols);
  return cellOp(g, tableId, `${row.id}:${col.id}`, cellStoryId(tableId, row.id, col.id), col.id, t);
}

/** Inserts (t < 0.3) or deletes rows or columns. */
function dimsOp(g: Gen, tableId: string, axis: 'row' | 'col', dims: { id: string }[], t: number): Op | null {
  const { random, makeId } = g;
  if (t < 0.3) {
    const newDim = () => (axis === 'row' ? { id: makeId() } : { id: makeId(), width: 80 });
    const items = Array.from({ length: 1 + Math.floor(random() * 2) }, newDim);
    return { type: 'insertTableDims', table: tableId, axis, at: Math.floor(random() * (dims.length + 1)), items };
  }
  if (!dims.length) return null;
  const at = Math.floor(random() * dims.length);
  return { type: 'deleteTableDims', table: tableId, axis, at, count: 1 + Math.floor(random() * Math.min(2, dims.length - at)) };
}

/** Merges or shades a cell (t < 0.7), sizes its column, types into it, or aligns the table. */
function cellOp(g: Gen, tableId: string, key: string, cellStory: string, colId: string, t: number): Op | null {
  const { doc, random } = g;
  if (t < 0.7) {
    const patch = random() < 0.5 ? { rowSpan: 2, colSpan: 2 } : { background: '#00ff00', rowSpan: null };
    return { type: 'setTableCells', table: tableId, cells: [[key, patch]] };
  }
  if (t < 0.85) return { type: 'setTableDims', table: tableId, axis: 'col', dims: [[colId, { width: 20 + Math.floor(random() * 100) }]] };
  if (t < 0.92) {
    // Type into a cell.
    const s = doc.stories.get(cellStory);
    if (!s) return null;
    return { type: 'insert', story: cellStory, at: Math.floor(random() * s.length), content: randomText(random) };
  }
  return { type: 'setTable', table: tableId, patch: { align: random() < 0.5 ? 'center' : null } };
}

/** Anchors (r < 0.94), headers, document properties, styles and lists. */
function docOp(g: Gen, r: number): Op {
  const { doc, random, makeId } = g;
  if (r < 0.94) return anchorOp(g);
  if (r < 0.97) {
    const header = headerStoryId(FINAL_SECTION, random() < 0.5 ? 'header' : 'footer', 'default');
    return doc.stories.has(header) ? { type: 'deleteStory', story: header } : { type: 'createStory', story: header };
  }
  if (r < 0.98) return { type: 'setDocProps', patch: { pageless: random() < 0.5 ? true : null } };
  if (r < 0.99) return { type: 'patchStyles', set: { custom: { name: `Custom ${Math.floor(random() * 10)}`, basedOn: 'normal', text: { bold: true } } } };
  return { type: 'patchLists', set: { [makeId()]: { levels: [{ format: 'decimal', text: '%1)', indent: 36, hanging: 18 }] } } };
}

/** Removes a comment, or sets one (a new one, or an existing one moved); or changes a discussion. */
function anchorOp(g: Gen): Op {
  const { doc, random, makeId, storyId, len } = g;
  if (random() < 0.3) return commentOp(g);
  const anchors = [...doc.anchors.values()];
  if (anchors.length && random() < 0.3) return { type: 'patchAnchors', remove: [pick(random, anchors).id] };
  const from = g.pos();
  const to = from + Math.floor(random() * (len - from));
  const id = anchors.length && random() < 0.5 ? pick(random, anchors).id : makeId();
  return { type: 'patchAnchors', set: [{ id, kind: 'comment', story: storyId, from, to }] };
}

/** Starts, resolves or removes a discussion. */
function commentOp(g: Gen): Op {
  const { doc, random, makeId } = g;
  const threads = [...doc.comments.values()];
  if (threads.length && random() < 0.3) return { type: 'patchComments', remove: [pick(random, threads).id] };
  const id = threads.length && random() < 0.5 ? pick(random, threads).id : makeId();
  const comment: DocComment = { id, author: { id: 'u1', name: 'Ann' }, createdAt: Math.floor(random() * 100) };
  if (random() < 0.3) comment.resolved = true;
  return { type: 'patchComments', set: [comment] };
}
