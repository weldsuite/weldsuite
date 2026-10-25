/**
 * Whether a (well-formed) op fits the document it is about to be applied to.
 * The room runs this on every batch after transforming it, so a client can
 * never break the invariants the editor and layout rely on:
 *
 * - every story ends with a paragraph mark, which is never deleted and never
 *   has anything inserted after it;
 * - no position splits a surrogate pair;
 * - every object character has data, every paragraph mark has properties;
 * - each table object owns exactly one table and its cells, and ids are
 *   unique across the document.
 *
 * An op on a story or table that does not exist passes: it does nothing when
 * applied (someone deleted its target first).
 */

import { OBJECT, PARA, isStoryText, splitsSurrogate } from '../model/chars';
import type { Content, StoryContent } from '../model/content';
import type { DocModel } from '../model/document';
import { sectionStoryIds } from '../model/document';
import { cellStoryId, footnoteStoryId, headerSection, type ObjectData, type TableData } from '../model/objects';
import { NORMAL } from '../model/defaults';
import { applyOp } from './apply';
import { runsLength, type Op, type OpOf, type SimpleOp } from './types';

export function validateOp(doc: DocModel, op: Op): string | null {
  if (op.type !== 'batch') return validateSimple(doc, op);
  // Each op of a batch applies to what the ones before it left, so check
  // them in turn on the document itself, then put it back as it was.
  const inverses: Op[] = [];
  let error: string | null = null;
  try {
    for (const o of op.ops) {
      error = validateOp(doc, o);
      if (error) break;
      inverses.push(applyOp(doc, o));
    }
  } catch (e) {
    error = e instanceof Error ? e.message : 'op could not be applied';
  }
  for (let i = inverses.length - 1; i >= 0; i--) applyOp(doc, inverses[i]!);
  return error;
}

function validateSimple(doc: DocModel, op: SimpleOp): string | null {
  switch (op.type) {
    case 'insert':
      return validateInsert(doc, op);
    case 'delete':
      return validateDelete(doc, op);
    case 'formatText':
    case 'formatParagraphs':
      return validateFormat(doc, op);
    case 'setObject':
      return validateSetObject(doc, op);
    case 'insertTableDims':
      return validateInsertDims(doc, op);
    case 'deleteTableDims':
      return validateDeleteDims(doc, op);
    case 'setTableCells':
      return op.cells.some(([key]) => key.split(':').length !== 2) ? 'bad cell key' : null;
    case 'createStory':
      return validateCreateStory(doc, op);
    case 'deleteStory':
      return headerSection(op.story) ? null : 'only header and footer stories can be deleted';
    case 'patchStyles':
      return op.remove?.includes(NORMAL) ? 'the normal style cannot be removed' : null;
    case 'patchComments':
      return validateComments(doc, op);
    case 'patchAnchors':
      return validateAnchors(doc, op);
    default:
      return null;
  }
}

function validateInsert(doc: DocModel, op: OpOf<'insert'>): string | null {
  const story = doc.stories.get(op.story);
  if (!story) return null;
  if (op.at > story.length - 1) return 'insert after the final paragraph mark';
  if (splitsAt(story, op.at)) return 'insert splits a character';
  return validateContent(doc, op.content);
}

function validateDelete(doc: DocModel, op: OpOf<'delete'>): string | null {
  const story = doc.stories.get(op.story);
  if (!story) return null;
  if (op.from > op.to || op.to > story.length - 1) return 'delete out of range (the final paragraph mark stays)';
  if (splitsAt(story, op.from) || splitsAt(story, op.to)) return 'delete splits a character';
  return null;
}

function validateFormat(doc: DocModel, op: OpOf<'formatText'> | OpOf<'formatParagraphs'>): string | null {
  const story = doc.stories.get(op.story);
  if (!story) return null;
  return op.at + runsLength(op.runs) > story.length ? 'format out of range' : null;
}

function validateSetObject(doc: DocModel, op: OpOf<'setObject'>): string | null {
  const story = doc.stories.get(op.story);
  if (!story) return null;
  if (op.at >= story.length || story.charAt(op.at) !== OBJECT) return 'no object at that position';
  const obj = story.attrAt(op.at) as ObjectData;
  if ('kind' in op.patch || 'id' in op.patch) return 'object kind and id cannot change';
  return patchFitsKind(obj.kind, op.patch);
}

function validateInsertDims(doc: DocModel, op: OpOf<'insertTableDims'>): string | null {
  const table = doc.tables.get(op.table);
  if (!table) return null;
  const dims = op.axis === 'row' ? table.rows : table.cols;
  if (op.at > dims.length) return 'insert past the end of the table';
  const ids = new Set(dims.map((d) => d.id));
  for (const d of op.items) {
    if (ids.has(d.id) || d.id.includes(':')) return `duplicate or invalid ${op.axis} id`;
    ids.add(d.id);
    if (op.axis === 'col' && !('width' in d)) return 'column without a width';
  }
  return validateNewCells(doc, op.table, table, op.axis, op.items.map((d) => d.id), op.content ?? {});
}

function validateDeleteDims(doc: DocModel, op: OpOf<'deleteTableDims'>): string | null {
  const table = doc.tables.get(op.table);
  if (!table) return null;
  const dims = op.axis === 'row' ? table.rows : table.cols;
  return op.at + op.count > dims.length ? 'delete past the end of the table' : null;
}

function validateCreateStory(doc: DocModel, op: OpOf<'createStory'>): string | null {
  if (!headerSection(op.story)) return 'only header and footer stories can be created';
  if (!op.content) return null;
  if (!op.content.text.endsWith(PARA)) return 'a story ends with a paragraph mark';
  return validateContent(doc, op.content);
}

function validateAnchors(doc: DocModel, op: OpOf<'patchAnchors'>): string | null {
  for (const a of op.set ?? []) {
    const story = doc.stories.get(a.story);
    if (story && (a.from > a.to || a.to > story.length)) return 'anchor out of range';
  }
  return null;
}

/** A reply belongs to a thread that exists (or arrives in the same op); only a first comment carries thread fields. */
function validateComments(doc: DocModel, op: OpOf<'patchComments'>): string | null {
  const arriving = new Set((op.set ?? []).filter((c) => c.thread === c.id).map((c) => c.id));
  for (const c of op.set ?? []) {
    if (c.thread === c.id) continue;
    if (!arriving.has(c.thread) && doc.comments.get(c.thread)?.thread !== c.thread) return 'a reply needs its thread';
    if (c.resolved !== undefined || c.suggestion !== undefined || c.quote !== undefined) return 'only a thread is resolved or quotes';
  }
  return null;
}

function splitsAt(story: { text(from: number, to: number): string }, pos: number): boolean {
  return pos > 0 && splitsSurrogate(story.text(pos - 1, pos + 1), 1);
}

const PATCH_KEYS: Record<string, Set<string>> = {
  image: new Set(['src', 'width', 'height', 'alt', 'crop', 'wrap', 'offsetX', 'offsetY', 'border']),
  sectionBreak: new Set(['start', 'section']),
  field: new Set(['field', 'format']),
  chip: new Set(['type', 'ref', 'label']),
  equation: new Set(['latex']),
};

function patchFitsKind(kind: string, patch: object): string | null {
  const allowed = PATCH_KEYS[kind] ?? new Set<string>();
  for (const k of Object.keys(patch)) if (!allowed.has(k)) return `a ${kind} has no ${k}`;
  // Required fields cannot be removed.
  for (const [k, v] of Object.entries(patch)) {
    if (v === null && ['src', 'width', 'height', 'start', 'section', 'field', 'type', 'ref', 'label', 'latex'].includes(k)) return `${k} is required`;
  }
  return null;
}

// ---------------------------------------------------------------- content

/** Checks inserted content: its text, formatting offsets, objects, and what they own. */
export function validateContent(doc: DocModel, content: Content): string | null {
  const err = validateStoryContent(content);
  if (err) return err;
  const owned = emptyOwned();
  const ownErr = ownedIn(content, owned);
  if (ownErr) return ownErr;
  // Everything the content carries is owned by an object in it, and nothing it needs is missing.
  for (const id of Object.keys(content.tables ?? {})) if (!owned.tables.has(id)) return `table ${id} is not used`;
  for (const id of Object.keys(content.stories ?? {})) if (!owned.stories.has(id)) return `story ${id} is not used`;
  for (const [id, s] of Object.entries(content.stories ?? {})) {
    const e = validateStoryContent(s);
    if (e) return e;
    if (!s.text.endsWith(PARA)) return `story ${id} does not end with a paragraph mark`;
  }
  return checkFreshIds(doc, content);
}

export function validateStoryContent(content: StoryContent): string | null {
  const { text } = content;
  if (!isStoryText(text)) return 'text holds characters a document cannot';
  if (runsLength(content.runs ?? []) > text.length) return 'style runs longer than the text';
  for (const [o] of content.paras ?? []) if (text[o] !== PARA) return 'paragraph properties not on a paragraph mark';
  const objectAt = new Set<number>();
  for (const [o] of content.objects ?? []) {
    if (text[o] !== OBJECT || objectAt.has(o)) return 'object data not on an object character';
    objectAt.add(o);
  }
  for (let i = text.indexOf(OBJECT); i >= 0; i = text.indexOf(OBJECT, i + 1)) {
    if (!objectAt.has(i)) return 'object character without data';
  }
  return null;
}

/** What the objects of some content own, collected while checking it. */
interface Owned {
  tables: Set<string>;
  stories: Set<string>;
  /** Ids of the id-carrying objects seen so far (images excepted), so none is used twice. */
  ids: Set<string>;
}

function emptyOwned(): Owned {
  return { tables: new Set(), stories: new Set(), ids: new Set() };
}

/**
 * Adds the tables and stories the objects in `content` own, recursively, to
 * `owned`; an error when one is missing or owned twice. Passing the same
 * `owned` to several calls checks them as one piece of content.
 */
function ownedIn(content: Content, owned: Owned): string | null {
  return visitOwned(content, content, owned);
}

function visitOwned(story: StoryContent, content: Content, owned: Owned): string | null {
  for (const [, obj] of story.objects ?? []) {
    const err = claimId(obj, owned.ids) ?? visitObject(obj, content, owned);
    if (err) return err;
  }
  return null;
}

function claimId(obj: ObjectData, ids: Set<string>): string | null {
  if (!('id' in obj) || obj.kind === 'image') return null;
  if (ids.has(obj.id)) return `id ${obj.id} used twice`;
  ids.add(obj.id);
  return null;
}

function visitObject(obj: ObjectData, content: Content, owned: Owned): string | null {
  if (obj.kind === 'table') return visitTable(obj.id, content, owned);
  if (obj.kind === 'footnote') return visitStories([footnoteStoryId(obj.id)], content, owned);
  if (obj.kind === 'sectionBreak') return visitStories(sectionStoryIds(obj.id), content, owned);
  return null;
}

function visitTable(id: string, content: Content, owned: Owned): string | null {
  const t = content.tables?.[id];
  if (!t) return `table ${id} has no data`;
  if (owned.tables.has(id)) return `table ${id} is owned twice`;
  const err = validateTable(t);
  if (err) return err;
  owned.tables.add(id);
  for (const r of t.rows) {
    for (const c of t.cols) {
      const sid = cellStoryId(id, r.id, c.id);
      owned.stories.add(sid);
      const cell = content.stories?.[sid];
      const e = cell ? visitOwned(cell, content, owned) : null;
      if (e) return e;
    }
  }
  return null;
}

/** Footnote and section header stories: owned only when the content brings them. */
function visitStories(ids: string[], content: Content, owned: Owned): string | null {
  for (const sid of ids) {
    const story = content.stories?.[sid];
    if (!story) continue;
    if (owned.stories.has(sid)) return `story ${sid} is owned twice`;
    owned.stories.add(sid);
    const e = visitOwned(story, content, owned);
    if (e) return e;
  }
  return null;
}

function validateTable(t: TableData): string | null {
  if (t.rows.length === 0 || t.cols.length === 0) return 'a table needs a row and a column';
  const rowIds = new Set(t.rows.map((r) => r.id));
  const colIds = new Set(t.cols.map((c) => c.id));
  if (rowIds.size !== t.rows.length || colIds.size !== t.cols.length) return 'duplicate row or column id';
  for (const id of [...rowIds, ...colIds]) if (id.includes(':')) return 'row and column ids cannot contain ":"';
  for (const key of Object.keys(t.cells ?? {})) {
    const [r, c] = key.split(':');
    if (!r || !c || !rowIds.has(r) || !colIds.has(c)) return `cell ${key} is not in the table`;
  }
  return null;
}

/**
 * The content an inserted row or column brings back (an undo): only stories
 * of its own new cells, and what the objects in them own, checked as an
 * insert's content is, so no table or footnote ends up owned twice. The
 * cells share one `Owned`, so two cells cannot both claim the same object.
 */
function validateNewCells(
  doc: DocModel,
  tableId: string,
  table: TableData,
  axis: 'row' | 'col',
  newIds: string[],
  content: Pick<Content, 'tables' | 'stories'>,
): string | null {
  const cells = newCellStoryIds(tableId, table, axis, newIds);
  const owned = emptyOwned();
  for (const id of cells) {
    const err = validateNewCell(id, content, owned);
    if (err) return err;
  }
  for (const id of Object.keys(content.tables ?? {})) if (!owned.tables.has(id)) return `table ${id} is not used`;
  for (const [id, s] of Object.entries(content.stories ?? {})) {
    if (!cells.has(id) && !owned.stories.has(id)) return `story ${id} is not used`;
    const err = validateStoryContent(s);
    if (err) return err;
  }
  return checkFreshIds(doc, content);
}

/** Story ids of the cells that inserting rows/columns `newIds` creates. */
function newCellStoryIds(tableId: string, table: TableData, axis: 'row' | 'col', newIds: string[]): Set<string> {
  const cells = new Set<string>();
  for (const id of newIds) {
    for (const other of axis === 'row' ? table.cols : table.rows) {
      cells.add(axis === 'row' ? cellStoryId(tableId, id, other.id) : cellStoryId(tableId, other.id, id));
    }
  }
  return cells;
}

/** Checks one new cell's story, when the content brings it, and adds what it owns to `owned`. */
function validateNewCell(id: string, content: Pick<Content, 'tables' | 'stories'>, owned: Owned): string | null {
  const cell = content.stories?.[id];
  if (!cell) return null;
  const err = validateStoryContent(cell);
  if (err) return err;
  if (!cell.text.endsWith(PARA)) return `story ${id} does not end with a paragraph mark`;
  return ownedIn({ ...cell, tables: content.tables, stories: content.stories }, owned);
}

/** New tables, stories and id-carrying objects must not reuse ids already in the document. */
function checkFreshIds(doc: DocModel, content: Pick<Content, 'tables' | 'stories'> & Partial<StoryContent>): string | null {
  for (const id of Object.keys(content.tables ?? {})) if (doc.tables.has(id)) return `table ${id} already exists`;
  for (const id of Object.keys(content.stories ?? {})) if (doc.stories.has(id)) return `story ${id} already exists`;
  // Objects in the content's own text and in every story it brings.
  const all = [content.objects ?? [], ...Object.values(content.stories ?? {}).map((s) => s.objects ?? [])];
  for (const objects of all) {
    for (const [, obj] of objects) {
      if ((obj.kind === 'footnote' || obj.kind === 'sectionBreak' || obj.kind === 'table') && doc.hasId(obj.id)) return `id ${obj.id} already exists`;
    }
  }
  return null;
}
