/**
 * Applies an op to a document and returns its exact inverse (for undo, and
 * for a collaboration client to take its unconfirmed edits back off).
 *
 * An op on a story or table that no longer exists (deleted by someone else
 * meanwhile) does nothing and its inverse is a no-op: every replica runs the
 * same ops in the same order, so they all skip it alike.
 */

import { OBJECT, PARA } from '../model/chars';
import { contentToPiece, type Content, type StoryContent } from '../model/content';
import type { DocModel } from '../model/document';
import {
  IMMUTABLE_OBJECT_KEYS,
  cellKey,
  cellStoryId,
  type Anchor,
  type CellProps,
  type DimData,
  type ObjectData,
  type TableAxis,
  type TableData,
} from '../model/objects';
import { applyPatch, inversePatch, isEmptyObject, replacingPatch, sameValue, type ParaProps, type Patch } from '../model/styles';
import { NOOP, normalize, type FormatRun, type Op, type OpOf, type SimpleOp } from './types';

export function applyOp(doc: DocModel, op: Op): Op {
  if (op.type === 'batch') {
    const inverses: Op[] = [];
    for (const o of op.ops) inverses.push(applyOp(doc, o));
    return normalize({ type: 'batch', ops: inverses.reverse() });
  }
  return normalize(applySimple(doc, op));
}

function applySimple(doc: DocModel, op: SimpleOp): Op {
  if (op.type === 'insert' || op.type === 'delete' || op.type === 'formatText' || op.type === 'formatParagraphs' || op.type === 'setObject') {
    const story = doc.stories.get(op.story);
    if (story) story.versionBefore = story.version;
  }
  switch (op.type) {
    case 'insert':
      return applyInsert(doc, op);
    case 'delete':
      return applyDelete(doc, op);
    case 'formatText':
      return applyFormatText(doc, op);
    case 'formatParagraphs':
      return applyFormatParagraphs(doc, op);
    case 'setObject':
      return applySetObject(doc, op);
    case 'insertTableDims':
      return applyInsertDims(doc, op);
    case 'deleteTableDims':
      return applyDeleteDims(doc, op);
    case 'setTableDims':
      return applySetDims(doc, op);
    case 'setTableCells':
      return applySetCells(doc, op);
    case 'setTable':
      return applySetTable(doc, op);
    case 'createStory':
      return applyCreateStory(doc, op);
    case 'deleteStory':
      return applyDeleteStory(doc, op);
    case 'setDocProps': {
      const before = doc.props;
      doc.props = applyPatch(before, op.patch);
      return { type: 'setDocProps', patch: inversePatch(before, op.patch) };
    }
    case 'patchStyles':
      return patchMap(doc.styles, op.set, op.remove, (set, remove) => ({ type: 'patchStyles', set, remove }));
    case 'patchLists':
      return patchMap(doc.lists, op.set, op.remove, (set, remove) => ({ type: 'patchLists', set, remove }));
    case 'patchAnchors':
      return applyPatchAnchors(doc, op);
  }
}

function applySetTable(doc: DocModel, op: OpOf<'setTable'>): Op {
  const table = doc.tables.get(op.table);
  if (!table) return NOOP;
  const before = table.props ?? {};
  table.props = applyPatch(before, op.patch);
  return { type: 'setTable', table: op.table, patch: inversePatch(before, op.patch) };
}

function applyCreateStory(doc: DocModel, op: OpOf<'createStory'>): Op {
  if (doc.stories.has(op.story)) return NOOP;
  const content: Content = op.content ?? { text: PARA };
  doc.addOwned({ stories: { ...content.stories, [op.story]: content }, tables: content.tables });
  return { type: 'deleteStory', story: op.story };
}

function applyDeleteStory(doc: DocModel, op: OpOf<'deleteStory'>): Op {
  const story = doc.stories.get(op.story);
  if (!story) return NOOP;
  const content = doc.extract(op.story, 0, story.length);
  doc.removeOwned(op.story, 0, story.length);
  doc.stories.delete(op.story);
  return { type: 'createStory', story: op.story, content };
}

function applyPatchAnchors(doc: DocModel, op: OpOf<'patchAnchors'>): Op {
  const restore: Anchor[] = [];
  const drop: string[] = [];
  for (const a of op.set ?? []) {
    const old = doc.anchors.get(a.id);
    if (old) restore.push({ ...old });
    else drop.push(a.id);
    doc.anchors.set(a.id, { ...a });
  }
  for (const id of op.remove ?? []) {
    const old = doc.anchors.get(id);
    if (!old) continue;
    restore.push({ ...old });
    doc.anchors.delete(id);
  }
  return { type: 'patchAnchors', set: restore, remove: drop };
}

// ---------------------------------------------------------------- text

function applyInsert(doc: DocModel, op: OpOf<'insert'>): Op {
  const story = doc.stories.get(op.story);
  if (!story) return NOOP;
  const n = op.content.text.length;
  doc.addOwned(op.content);
  story.insert(op.at, contentToPiece(op.content, doc.textStyles));
  for (const a of doc.anchors.values()) {
    if (a.story !== op.story) continue;
    if (a.from >= op.at) a.from += n;
    if (a.to > op.at) a.to += n;
    if (a.to < a.from) a.to = a.from;
  }
  return { type: 'delete', story: op.story, from: op.at, to: op.at + n };
}

function applyDelete(doc: DocModel, op: OpOf<'delete'>): Op {
  const story = doc.stories.get(op.story);
  if (!story) return NOOP;
  const content = doc.extract(op.story, op.from, op.to);
  doc.removeOwned(op.story, op.from, op.to);
  story.remove(op.from, op.to);
  const moved: Anchor[] = [];
  const len = op.to - op.from;
  for (const a of doc.anchors.values()) {
    if (a.story !== op.story) continue;
    const from = mapDeleted(a.from, op.from, op.to, len);
    const to = mapDeleted(a.to, op.from, op.to, len);
    // Where re-inserting the text (the inverse) would put the anchor; when
    // that is not where it was, the inverse sets it back explicitly.
    const backFrom = from >= op.from ? from + len : from;
    const backTo = Math.max(backFrom, to > op.from ? to + len : to);
    if (backFrom !== a.from || backTo !== a.to) moved.push({ ...a });
    a.from = from;
    a.to = to;
  }
  const insert: Op = { type: 'insert', story: op.story, at: op.from, content };
  return moved.length ? { type: 'batch', ops: [insert, { type: 'patchAnchors', set: moved }] } : insert;
}

function mapDeleted(p: number, from: number, to: number, len: number): number {
  if (p <= from) return p;
  if (p >= to) return p - len;
  return from;
}

function applyFormatText(doc: DocModel, op: OpOf<'formatText'>): Op {
  const story = doc.stories.get(op.story);
  if (!story) return NOOP;
  const inverse: FormatRun<Patch<Record<string, unknown>>>[] = [];
  let pos = op.at;
  for (const [len, patch] of op.runs) {
    if (!patch) {
      inverse.push([len, null]);
      pos += len;
      continue;
    }
    // One inverse run per stretch of equal (old style → new style).
    let runStart = pos;
    let runOld = -1;
    let runNew = -1;
    const flush = (end: number) => {
      if (runOld < 0) return;
      const p = runOld === runNew ? null : replacingPatch(doc.textStyles.get(runNew), doc.textStyles.get(runOld));
      inverse.push([end - runStart, p && !isEmptyObject(p) ? p : null]);
    };
    story.mapStyles(pos, pos + len, (old, at) => {
      const next = doc.textStyles.patched(old, patch);
      if (old !== runOld || next !== runNew) {
        flush(at);
        runStart = at;
        runOld = old;
        runNew = next;
      }
      return next;
    });
    flush(pos + len);
    pos += len;
  }
  return { type: 'formatText', story: op.story, at: op.at, runs: mergeRuns(inverse) };
}

function applyFormatParagraphs(doc: DocModel, op: OpOf<'formatParagraphs'>): Op {
  const story = doc.stories.get(op.story);
  if (!story) return NOOP;
  const inverse: FormatRun<Patch<ParaProps>>[] = [];
  let pos = op.at;
  for (const [len, patch] of op.runs) {
    const end = pos + len;
    if (!patch) {
      inverse.push([len, null]);
      pos = end;
      continue;
    }
    let from = pos;
    for (let p = story.indexOf(PARA, pos); p >= 0 && p < end; p = story.indexOf(PARA, p + 1)) {
      const before = (story.attrAt(p) as ParaProps | undefined) ?? {};
      story.setAttr(p, applyPatch(before, patch));
      // [from, p] holds exactly this one mark.
      inverse.push([p + 1 - from, inversePatch(before, patch)]);
      from = p + 1;
    }
    if (end > from) inverse.push([end - from, null]);
    pos = end;
  }
  return { type: 'formatParagraphs', story: op.story, at: op.at, runs: mergeRuns(inverse) };
}

function applySetObject(doc: DocModel, op: OpOf<'setObject'>): Op {
  const story = doc.stories.get(op.story);
  if (!story || story.charAt(op.at) !== OBJECT) return NOOP;
  const before = story.attrAt(op.at) as ObjectData;
  const patch = Object.fromEntries(Object.entries(op.patch).filter(([k]) => !IMMUTABLE_OBJECT_KEYS.has(k)));
  story.setAttr(op.at, applyPatch(before as unknown as Record<string, unknown>, patch) as unknown as ObjectData);
  return { type: 'setObject', story: op.story, at: op.at, patch: inversePatch(before as unknown as Record<string, unknown>, patch) };
}

/** Joins neighbouring runs with equal patches. */
function mergeRuns<P>(runs: FormatRun<P>[]): FormatRun<P>[] {
  const out: FormatRun<P>[] = [];
  for (const [len, patch] of runs) {
    if (len === 0) continue;
    const last = out[out.length - 1];
    if (last && sameValue(last[1], patch)) last[0] += len;
    else out.push([len, patch]);
  }
  return out;
}

// ---------------------------------------------------------------- tables

function dimsOf(table: TableData, axis: TableAxis): DimData[] {
  return axis === 'row' ? table.rows : table.cols;
}

/** Each merged cell's anchor index, span and key along `axis`. */
function spans(table: TableData, axis: TableAxis): { key: string; index: number; span: number }[] {
  const out: { key: string; index: number; span: number }[] = [];
  const rowIndex = new Map(table.rows.map((r, i) => [r.id, i]));
  const colIndex = new Map(table.cols.map((c, i) => [c.id, i]));
  for (const [key, props] of Object.entries(table.cells ?? {})) {
    const span = axis === 'row' ? props.rowSpan : props.colSpan;
    if (!span || span <= 1) continue;
    const [rowId, colId] = key.split(':') as [string, string];
    const index = axis === 'row' ? rowIndex.get(rowId) : colIndex.get(colId);
    if (index !== undefined) out.push({ key, index, span });
  }
  return out;
}

function setSpan(table: TableData, axis: TableAxis, key: string, span: number): void {
  const cells = (table.cells ??= {});
  const props: CellProps = { ...cells[key] };
  if (axis === 'row') props.rowSpan = span;
  else props.colSpan = span;
  if (span <= 1) delete props[axis === 'row' ? 'rowSpan' : 'colSpan'];
  if (isEmptyObject(props)) delete cells[key];
  else cells[key] = props;
}

function applyInsertDims(doc: DocModel, op: OpOf<'insertTableDims'>): Op {
  const table = doc.tables.get(op.table);
  if (!table) return NOOP;
  const count = op.items.length;
  // A merge the insert falls inside grows to cover the new rows/columns.
  for (const s of spans(table, op.axis)) if (s.index < op.at && op.at < s.index + s.span) setSpan(table, op.axis, s.key, s.span + count);
  dimsOf(table, op.axis).splice(op.at, 0, ...op.items.map((d) => ({ ...d })));

  const newCellStories = addNewCells(table, op);
  if (op.content) doc.addOwned(reachable(op.content, newCellStories));
  doc.ensureCells(op.table, table);
  return { type: 'deleteTableDims', table: op.table, axis: op.axis, at: op.at, count };
}

/** Gives the cells of the inserted rows/columns the properties the op carries; returns their story ids. */
function addNewCells(table: TableData, op: OpOf<'insertTableDims'>): string[] {
  const newIds = new Set(op.items.map((d) => d.id));
  const stories: string[] = [];
  for (const r of table.rows) {
    for (const c of table.cols) {
      if (!newIds.has(op.axis === 'row' ? r.id : c.id)) continue;
      stories.push(cellStoryId(op.table, r.id, c.id));
      const key = cellKey(r.id, c.id);
      const props = op.cells?.[key];
      if (!props) continue;
      table.cells ??= {};
      table.cells[key] = { ...props };
    }
  }
  return stories;
}

function applyDeleteDims(doc: DocModel, op: OpOf<'deleteTableDims'>): Op {
  const table = doc.tables.get(op.table);
  if (!table) return NOOP;
  const dims = dimsOf(table, op.axis);
  const at = Math.min(op.at, dims.length);
  const count = Math.min(op.count, dims.length - at);
  if (count <= 0) return NOOP;
  const end = at + count;

  const restoreSpans = shrinkSpans(table, op.axis, at, end);
  const removed = dims.slice(at, end);
  const { cells, content } = takeCells(doc, op.table, table, op.axis, new Set(removed.map((d) => d.id)));
  dims.splice(at, count);

  const insert: Op = {
    type: 'insertTableDims',
    table: op.table,
    axis: op.axis,
    at,
    items: removed,
    ...(Object.keys(cells).length ? { cells } : {}),
    content,
  };
  return restoreSpans.length ? { type: 'batch', ops: [insert, { type: 'setTableCells', table: op.table, cells: restoreSpans }] } : insert;
}

/**
 * Shrinks the merges a delete of [at, end) cuts into (ones anchored in it go
 * with it); returns the patches that give them their old spans back.
 */
function shrinkSpans(table: TableData, axis: TableAxis, at: number, end: number): [string, Patch<CellProps>][] {
  const restore: [string, Patch<CellProps>][] = [];
  for (const s of spans(table, axis)) {
    if (s.index >= at && s.index < end) continue;
    const overlap = Math.max(0, Math.min(end, s.index + s.span) - Math.max(at, s.index));
    if (overlap === 0) continue;
    restore.push([s.key, { [axis === 'row' ? 'rowSpan' : 'colSpan']: s.span }]);
    setSpan(table, axis, s.key, s.span - overlap);
  }
  return restore;
}

/**
 * Takes the cells of the rows/columns being deleted out of the table and the
 * document: their properties, and their stories with everything those own.
 */
function takeCells(
  doc: DocModel,
  tableId: string,
  table: TableData,
  axis: TableAxis,
  removedIds: Set<string>,
): { cells: Record<string, CellProps>; content: Required<Pick<Content, 'tables' | 'stories'>> } {
  const cells: Record<string, CellProps> = {};
  const content: Required<Pick<Content, 'tables' | 'stories'>> = { tables: {}, stories: {} };
  for (const r of table.rows) {
    for (const c of table.cols) {
      if (!removedIds.has(axis === 'row' ? r.id : c.id)) continue;
      const key = cellKey(r.id, c.id);
      if (table.cells?.[key]) {
        cells[key] = table.cells[key]!;
        delete table.cells[key];
      }
      takeCellStory(doc, cellStoryId(tableId, r.id, c.id), content);
    }
  }
  return { cells, content };
}

/** Moves one cell's story (and what it owns) out of the document into `content`. */
function takeCellStory(doc: DocModel, sid: string, content: Required<Pick<Content, 'tables' | 'stories'>>): void {
  const story = doc.stories.get(sid);
  if (!story) return;
  const extracted = doc.extract(sid, 0, story.length);
  content.stories[sid] = storyPart(extracted);
  Object.assign(content.tables, extracted.tables);
  Object.assign(content.stories, extracted.stories);
  doc.removeOwned(sid, 0, story.length);
  doc.stories.delete(sid);
}

function applySetDims(doc: DocModel, op: OpOf<'setTableDims'>): Op {
  const table = doc.tables.get(op.table);
  if (!table) return NOOP;
  const dims = dimsOf(table, op.axis) as unknown as Record<string, unknown>[];
  const inverse: [string, Patch<Record<string, unknown>>][] = [];
  for (const [id, patch] of op.dims) {
    const i = dims.findIndex((d) => d.id === id);
    if (i < 0) continue;
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'id'));
    inverse.push([id, inversePatch(dims[i]!, clean)]);
    dims[i] = applyPatch(dims[i]!, clean);
  }
  return { type: 'setTableDims', table: op.table, axis: op.axis, dims: inverse.reverse() } as Op;
}

function applySetCells(doc: DocModel, op: OpOf<'setTableCells'>): Op {
  const table = doc.tables.get(op.table);
  if (!table) return NOOP;
  const rows = new Set(table.rows.map((r) => r.id));
  const cols = new Set(table.cols.map((c) => c.id));
  const inverse: [string, Patch<CellProps>][] = [];
  for (const [key, patch] of op.cells) {
    const [rowId, colId] = key.split(':') as [string, string];
    if (!rows.has(rowId) || !cols.has(colId)) continue;
    const cellMap = (table.cells ??= {});
    const before = cellMap[key] ?? {};
    inverse.push([key, inversePatch(before, patch)]);
    const after = applyPatch(before, patch);
    if (isEmptyObject(after)) delete cellMap[key];
    else cellMap[key] = after;
  }
  return { type: 'setTableCells', table: op.table, cells: inverse.reverse() };
}

// ---------------------------------------------------------------- helpers

/** Only the stories reachable from `roots` (and the tables on the way), so nothing orphaned is created. */
function reachable(content: Pick<Content, 'tables' | 'stories'>, roots: string[]): Pick<Content, 'tables' | 'stories'> {
  const out: Required<Pick<Content, 'tables' | 'stories'>> = { tables: {}, stories: {} };
  const queue = roots.filter((id) => content.stories?.[id]);
  while (queue.length) {
    const id = queue.pop()!;
    if (out.stories[id]) continue;
    const story = content.stories![id]!;
    out.stories[id] = story;
    for (const [, obj] of story.objects ?? []) visitOwner(obj, content, out, queue);
  }
  return out;
}

/** Queues the stories an object owns that are not taken yet, and takes its table. */
function visitOwner(
  obj: ObjectData,
  content: Pick<Content, 'tables' | 'stories'>,
  out: Required<Pick<Content, 'tables' | 'stories'>>,
  queue: string[],
): void {
  for (const sid of ownedIdsInContent(obj, content)) {
    if (content.stories?.[sid] && !out.stories[sid]) queue.push(sid);
  }
  if (obj.kind === 'table' && content.tables?.[obj.id]) out.tables[obj.id] = content.tables[obj.id]!;
}

function ownedIdsInContent(obj: ObjectData, content: Pick<Content, 'tables' | 'stories'>): string[] {
  if (obj.kind === 'table') {
    const t = content.tables?.[obj.id];
    if (!t) return [];
    return t.rows.flatMap((r) => t.cols.map((c) => cellStoryId(obj.id, r.id, c.id)));
  }
  if (obj.kind === 'footnote') return [`fn:${obj.id}`];
  if (obj.kind === 'sectionBreak') return Object.keys(content.stories ?? {}).filter((id) => id.startsWith(`hdr:${obj.id}:`) || id.startsWith(`ftr:${obj.id}:`));
  return [];
}

/** The story's own part of `content`, without the tables and stories its objects own. */
function storyPart(content: Content): StoryContent {
  const part: Content = { ...content };
  delete part.tables;
  delete part.stories;
  return part;
}

function patchMap<T>(
  map: Map<string, T>,
  set: Record<string, T> | undefined,
  remove: string[] | undefined,
  make: (set: Record<string, T>, remove: string[]) => Op,
): Op {
  const restore: Record<string, T> = {};
  const drop: string[] = [];
  for (const [id, value] of Object.entries(set ?? {})) {
    const old = map.get(id);
    if (old !== undefined) restore[id] = old;
    else drop.push(id);
    map.set(id, value);
  }
  for (const id of remove ?? []) {
    const old = map.get(id);
    if (old === undefined) continue;
    if (!(id in restore)) restore[id] = old;
    map.delete(id);
  }
  return make(restore, drop);
}
