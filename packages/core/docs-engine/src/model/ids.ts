/**
 * Ids for tables, rows, columns, footnotes, sections and lists. Random, so
 * two people creating things at the same moment never collide; short, since
 * they appear in story ids and every op that touches a table.
 */

import type { Content, StoryContent } from './content';
import { cellStoryId, footnoteStoryId, headerSection, headerStoryId, type CellProps, type ObjectData, type TableData } from './objects';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newId(length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * The same content with new ids for everything it creates (tables, their
 * rows and columns, footnotes, section breaks, and the stories they own), so
 * it can be pasted again and again into one document.
 */
export function freshIds(content: Content, makeId: () => string = newId): Content {
  const tables: Record<string, TableData> = {};
  const stories: Record<string, StoryContent> = {};

  const visit = (s: StoryContent): StoryContent => {
    if (!s.objects?.length) return s;
    const objects = s.objects.map(([offset, obj]): [number, ObjectData] => [offset, remap(obj)]);
    return { ...s, objects };
  };

  const remap = (obj: ObjectData): ObjectData => {
    if (obj.kind === 'table') {
      const table = content.tables?.[obj.id];
      const id = makeId();
      if (!table) return { ...obj, id };
      const rowIds = new Map(table.rows.map((r) => [r.id, makeId()]));
      const colIds = new Map(table.cols.map((c) => [c.id, makeId()]));
      const cells: Record<string, CellProps> = {};
      for (const [key, props] of Object.entries(table.cells ?? {})) {
        const [r, c] = key.split(':') as [string, string];
        if (rowIds.has(r) && colIds.has(c)) cells[`${rowIds.get(r)}:${colIds.get(c)}`] = props;
      }
      tables[id] = {
        ...table,
        rows: table.rows.map((r) => ({ ...r, id: rowIds.get(r.id)! })),
        cols: table.cols.map((c) => ({ ...c, id: colIds.get(c.id)! })),
        cells,
      };
      if (!Object.keys(cells).length) delete tables[id]!.cells;
      for (const r of table.rows) {
        for (const c of table.cols) {
          const cell = content.stories?.[cellStoryId(obj.id, r.id, c.id)];
          if (cell) stories[cellStoryId(id, rowIds.get(r.id)!, colIds.get(c.id)!)] = visit(cell);
        }
      }
      return { ...obj, id };
    }
    if (obj.kind === 'footnote') {
      const id = makeId();
      const story = content.stories?.[footnoteStoryId(obj.id)];
      if (story) stories[footnoteStoryId(id)] = visit(story);
      return { ...obj, id };
    }
    if (obj.kind === 'sectionBreak') {
      const id = makeId();
      for (const [sid, story] of Object.entries(content.stories ?? {})) {
        const h = headerSection(sid);
        if (h && h.sectionId === obj.id) stories[headerStoryId(id, h.kind, h.variant)] = visit(story);
      }
      return { ...obj, id };
    }
    if (obj.kind === 'image') return { ...obj, id: makeId() };
    return obj;
  };

  const top = visit(content);
  const out: Content = { text: top.text };
  if (top.runs) out.runs = top.runs;
  if (top.paras) out.paras = top.paras;
  if (top.objects) out.objects = top.objects;
  if (Object.keys(tables).length) out.tables = tables;
  if (Object.keys(stories).length) out.stories = stories;
  return out;
}
