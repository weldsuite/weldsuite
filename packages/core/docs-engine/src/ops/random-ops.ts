/**
 * Random valid ops against a document, for the fuzz tests (inverse
 * exactness, convergence). Not exported from the package.
 */

import { OBJECT, PARA } from '../model/chars';
import type { Content } from '../model/content';
import type { DocModel } from '../model/document';
import { BODY, cellStoryId, footnoteStoryId, headerStoryId, FINAL_SECTION, type ObjectData } from '../model/objects';
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

function attemptOp(doc: DocModel, random: () => number, makeId: () => string): Op | null {
  const storyId = randomStory(doc, random);
  const story = doc.stories.get(storyId)!;
  const len = story.length;
  const pos = () => Math.floor(random() * len); // before the final mark: [0, len-1]
  const r = random();
  const tables = [...doc.tables.keys()];

  if (r < 0.3) return { type: 'insert', story: storyId, at: pos(), content: randomText(random) };
  if (r < 0.33) {
    return {
      type: 'insert',
      story: storyId,
      at: pos(),
      content: objectContent({ kind: 'image', id: makeId(), src: 'https://example.com/a.png', width: 100, height: 50 }),
    };
  }
  if (r < 0.37) {
    const id = makeId();
    const rows = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ id: makeId() }));
    const cols = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ id: makeId(), width: 100 }));
    const stories: Record<string, Content> = {};
    stories[cellStoryId(id, rows[0]!.id, cols[0]!.id)] = { text: `cell${PARA}` };
    return { type: 'insert', story: storyId, at: pos(), content: objectContent({ kind: 'table', id }, { tables: { [id]: { rows, cols } }, stories }) };
  }
  if (r < 0.39) {
    const id = makeId();
    return { type: 'insert', story: storyId, at: pos(), content: objectContent({ kind: 'footnote', id }, { stories: { [footnoteStoryId(id)]: { text: `note${PARA}` } } }) };
  }
  if (r < 0.58) {
    if (len <= 1) return null;
    const from = Math.floor(random() * (len - 1));
    const to = Math.min(len - 1, from + 1 + Math.floor(random() * 12));
    return { type: 'delete', story: storyId, from, to };
  }
  if (r < 0.66) {
    const at = pos();
    const a = 1 + Math.floor(random() * Math.max(1, len - at));
    const runs: [number, Record<string, unknown> | null][] = [[Math.min(a, len - at), random() < 0.5 ? { italic: true, color: '#ff0000' } : { italic: null }]];
    if (random() < 0.3 && at + a < len) runs.push([1, null], [Math.max(0, Math.min(2, len - at - a - 1)), { underline: true }]);
    return { type: 'formatText', story: storyId, at, runs } as Op;
  }
  if (r < 0.72) {
    const at = pos();
    return { type: 'formatParagraphs', story: storyId, at, runs: [[Math.min(len - at, 1 + Math.floor(random() * 20)), random() < 0.5 ? { align: 'right', style: 'heading2' } : { align: null }]] };
  }
  if (r < 0.75) {
    const images: number[] = [];
    story.forEachAttr(0, len, (p, a) => {
      if ((a as ObjectData).kind === 'image') images.push(p);
    });
    if (!images.length) return null;
    return { type: 'setObject', story: storyId, at: pick(random, images), patch: { width: 10 + Math.floor(random() * 200), alt: random() < 0.5 ? 'pic' : null } };
  }
  if (r < 0.9) {
    if (!tables.length) return null;
    const tableId = pick(random, tables);
    const table = doc.tables.get(tableId)!;
    const t = random();
    const axis = random() < 0.5 ? 'row' : 'col';
    const dims = axis === 'row' ? table.rows : table.cols;
    if (t < 0.3) {
      const items = Array.from({ length: 1 + Math.floor(random() * 2) }, () => (axis === 'row' ? { id: makeId() } : { id: makeId(), width: 80 }));
      return { type: 'insertTableDims', table: tableId, axis, at: Math.floor(random() * (dims.length + 1)), items };
    }
    if (t < 0.5) {
      if (!dims.length) return null;
      const at = Math.floor(random() * dims.length);
      return { type: 'deleteTableDims', table: tableId, axis, at, count: 1 + Math.floor(random() * Math.min(2, dims.length - at)) };
    }
    if (!table.rows.length || !table.cols.length) return null;
    const row = pick(random, table.rows);
    const col = pick(random, table.cols);
    if (t < 0.7) return { type: 'setTableCells', table: tableId, cells: [[`${row.id}:${col.id}`, random() < 0.5 ? { rowSpan: 2, colSpan: 2 } : { background: '#00ff00', rowSpan: null }]] };
    if (t < 0.85) return { type: 'setTableDims', table: tableId, axis: 'col', dims: [[col.id, { width: 20 + Math.floor(random() * 100) }]] };
    if (t < 0.92) {
      // Type into a cell.
      const cell = cellStoryId(tableId, row.id, col.id);
      const s = doc.stories.get(cell);
      if (!s) return null;
      return { type: 'insert', story: cell, at: Math.floor(random() * s.length), content: randomText(random) };
    }
    return { type: 'setTable', table: tableId, patch: { align: random() < 0.5 ? 'center' : null } };
  }
  if (r < 0.94) {
    const anchors = [...doc.anchors.values()];
    if (anchors.length && random() < 0.3) return { type: 'patchAnchors', remove: [pick(random, anchors).id] };
    const from = pos();
    const to = from + Math.floor(random() * (len - from));
    const id = anchors.length && random() < 0.5 ? pick(random, anchors).id : makeId();
    return { type: 'patchAnchors', set: [{ id, kind: 'comment', story: storyId, from, to }] };
  }
  if (r < 0.97) {
    const header = headerStoryId(FINAL_SECTION, random() < 0.5 ? 'header' : 'footer', 'default');
    return doc.stories.has(header) ? { type: 'deleteStory', story: header } : { type: 'createStory', story: header };
  }
  if (r < 0.98) return { type: 'setDocProps', patch: { pageless: random() < 0.5 ? true : null } };
  if (r < 0.99) return { type: 'patchStyles', set: { custom: { name: `Custom ${Math.floor(random() * 10)}`, basedOn: 'normal', text: { bold: true } } } };
  return { type: 'patchLists', set: { [makeId()]: { levels: [{ format: 'decimal', text: '%1)', indent: 36, hanging: 18 }] } } };
}
