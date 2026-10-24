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
import { runsLength, type Op, type SimpleOp } from './types';

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
    case 'insert': {
      const story = doc.stories.get(op.story);
      if (!story) return null;
      if (op.at > story.length - 1) return 'insert after the final paragraph mark';
      if (splitsAt(story, op.at)) return 'insert splits a character';
      return validateContent(doc, op.content);
    }
    case 'delete': {
      const story = doc.stories.get(op.story);
      if (!story) return null;
      if (op.from > op.to || op.to > story.length - 1) return 'delete out of range (the final paragraph mark stays)';
      if (splitsAt(story, op.from) || splitsAt(story, op.to)) return 'delete splits a character';
      return null;
    }
    case 'formatText':
    case 'formatParagraphs': {
      const story = doc.stories.get(op.story);
      if (!story) return null;
      if (op.at + runsLength(op.runs) > story.length) return 'format out of range';
      return null;
    }
    case 'setObject': {
      const story = doc.stories.get(op.story);
      if (!story) return null;
      if (op.at >= story.length || story.charAt(op.at) !== OBJECT) return 'no object at that position';
      const obj = story.attrAt(op.at) as ObjectData;
      if ('kind' in op.patch || 'id' in op.patch) return 'object kind and id cannot change';
      return patchFitsKind(obj.kind, op.patch);
    }
    case 'insertTableDims': {
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
    case 'deleteTableDims': {
      const table = doc.tables.get(op.table);
      if (!table) return null;
      const dims = op.axis === 'row' ? table.rows : table.cols;
      return op.at + op.count > dims.length ? 'delete past the end of the table' : null;
    }
    case 'setTableCells':
      return op.cells.some(([key]) => key.split(':').length !== 2) ? 'bad cell key' : null;
    case 'createStory': {
      const header = headerSection(op.story);
      if (!header) return 'only header and footer stories can be created';
      if (op.content) {
        if (!op.content.text.endsWith(PARA)) return 'a story ends with a paragraph mark';
        const err = validateContent(doc, op.content);
        if (err) return err;
      }
      return null;
    }
    case 'deleteStory':
      return headerSection(op.story) ? null : 'only header and footer stories can be deleted';
    case 'patchStyles':
      if (op.remove?.includes(NORMAL)) return 'the normal style cannot be removed';
      return null;
    case 'patchAnchors': {
      for (const a of op.set ?? []) {
        const story = doc.stories.get(a.story);
        if (story && (a.from > a.to || a.to > story.length)) return 'anchor out of range';
      }
      return null;
    }
    default:
      return null;
  }
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
  const owned = ownedIn(content);
  if (typeof owned === 'string') return owned;
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

/** The tables and stories the objects in `content` own, recursively; an error when one is missing. */
function ownedIn(content: Content): { tables: Set<string>; stories: Set<string> } | string {
  const tables = new Set<string>();
  const stories = new Set<string>();
  const ids = new Set<string>();
  const visit = (s: StoryContent): string | null => {
    for (const [, obj] of s.objects ?? []) {
      if ('id' in obj && obj.kind !== 'image') {
        if (ids.has(obj.id)) return `id ${obj.id} used twice`;
        ids.add(obj.id);
      }
      if (obj.kind === 'table') {
        const t = content.tables?.[obj.id];
        if (!t) return `table ${obj.id} has no data`;
        const err = validateTable(t);
        if (err) return err;
        tables.add(obj.id);
        for (const r of t.rows) {
          for (const c of t.cols) {
            const sid = cellStoryId(obj.id, r.id, c.id);
            stories.add(sid);
            const cell = content.stories?.[sid];
            if (cell) {
              const e = visit(cell);
              if (e) return e;
            }
          }
        }
      } else if (obj.kind === 'footnote' || obj.kind === 'sectionBreak') {
        const sids = obj.kind === 'footnote' ? [footnoteStoryId(obj.id)] : sectionStoryIds(obj.id);
        for (const sid of sids) {
          const owned = content.stories?.[sid];
          if (!owned) continue;
          stories.add(sid);
          const e = visit(owned);
          if (e) return e;
        }
      }
    }
    return null;
  };
  const err = visit(content);
  return err ?? { tables, stories };
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
 * insert's content is, so no table or footnote ends up owned twice.
 */
function validateNewCells(
  doc: DocModel,
  tableId: string,
  table: TableData,
  axis: 'row' | 'col',
  newIds: string[],
  content: Pick<Content, 'tables' | 'stories'>,
): string | null {
  const cells = new Set<string>();
  for (const id of newIds) {
    for (const other of axis === 'row' ? table.cols : table.rows) {
      cells.add(axis === 'row' ? cellStoryId(tableId, id, other.id) : cellStoryId(tableId, other.id, id));
    }
  }
  const tables = new Set<string>();
  const stories = new Set<string>(cells);
  for (const id of cells) {
    const cell = content.stories?.[id];
    if (!cell) continue;
    const err = validateStoryContent(cell);
    if (err) return err;
    if (!cell.text.endsWith(PARA)) return `story ${id} does not end with a paragraph mark`;
    const owned = ownedIn({ ...cell, tables: content.tables, stories: content.stories });
    if (typeof owned === 'string') return owned;
    for (const t of owned.tables) tables.add(t);
    for (const s of owned.stories) stories.add(s);
  }
  for (const id of Object.keys(content.tables ?? {})) if (!tables.has(id)) return `table ${id} is not used`;
  for (const [id, s] of Object.entries(content.stories ?? {})) {
    if (!stories.has(id)) return `story ${id} is not used`;
    const err = validateStoryContent(s);
    if (err) return err;
  }
  return checkFreshIds(doc, content);
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
