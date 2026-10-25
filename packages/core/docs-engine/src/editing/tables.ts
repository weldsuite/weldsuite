/**
 * Table commands: inserting a table, adding and removing rows and columns,
 * merging and splitting cells, sizing columns, and cell formatting. Pure
 * functions returning ops, like the text commands.
 *
 * A table is an object character in its own paragraph; each cell is a story
 * (`cell:<table>:<row>:<col>`), so typing in a cell is ordinary text editing
 * in that story.
 */

import { OBJECT, PARA } from '../model/chars';
import type { Content } from '../model/content';
import type { DocModel } from '../model/document';
import { newId } from '../model/ids';
import { cellKey, cellStoryId, type CellProps, type ObjectData, type TableData, type TableProps } from '../model/objects';
import { isEmptyObject, replacingPatch, type ParaProps, type Patch } from '../model/styles';
import { batch, NOOP, type Op } from '../ops/types';
import { paragraphAt } from './boundaries';
import { caretAt, selectionRange, type DocSelection, type Edit } from './commands';
import { storiesInOrder } from './find';

export interface CellRef {
  tableId: string;
  rowId: string;
  colId: string;
  row: number;
  col: number;
}

/** The table cell a story is, or null for other stories. */
export function cellOf(doc: DocModel, storyId: string): CellRef | null {
  const m = /^cell:([^:]+):([^:]+):([^:]+)$/.exec(storyId);
  if (!m) return null;
  const table = doc.tables.get(m[1]!);
  if (!table) return null;
  const row = table.rows.findIndex((r) => r.id === m[2]);
  const col = table.cols.findIndex((c) => c.id === m[3]);
  if (row < 0 || col < 0) return null;
  return { tableId: m[1]!, rowId: m[2]!, colId: m[3]!, row, col };
}

/** Where a table's object character is: its story and position. */
export function findTable(doc: DocModel, tableId: string): { story: string; pos: number } | null {
  for (const id of storiesInOrder(doc)) {
    const story = doc.stories.get(id)!;
    let found = -1;
    story.forEachAttr(0, story.length, (pos, attr) => {
      if (found < 0 && story.charAt(pos) === OBJECT && (attr as ObjectData).kind === 'table' && (attr as { id: string }).id === tableId) found = pos;
    });
    if (found >= 0) return { story: id, pos: found };
  }
  return null;
}

/** The cell story at (row, col) of a table, following merges to the cell that shows there. */
export function cellStoryAt(doc: DocModel, tableId: string, row: number, col: number): string | null {
  const t = doc.tables.get(tableId);
  const r = t?.rows[row];
  const c = t?.cols[col];
  if (!t || !r || !c) return null;
  const anchor = mergeAnchor(t, row, col);
  return cellStoryId(tableId, t.rows[anchor.row]!.id, t.cols[anchor.col]!.id);
}

/** The top-left cell of the merge covering (row, col), or the cell itself. */
export function mergeAnchor(t: TableData, row: number, col: number): { row: number; col: number } {
  for (let r = 0; r <= row; r++) {
    for (let c = 0; c <= col; c++) {
      const p = t.cells?.[cellKey(t.rows[r]!.id, t.cols[c]!.id)];
      if (!p) continue;
      if (r + (p.rowSpan ?? 1) > row && c + (p.colSpan ?? 1) > col && (r !== row || c !== col)) return { row: r, col: c };
    }
  }
  return { row, col };
}

const DEFAULT_WIDTH = 451;

/**
 * Inserts a rows × cols table at the selection: into an empty paragraph as it
 * is, otherwise as a new paragraph after the one the caret is in. The caret
 * goes into the first cell.
 */
export function insertTable(doc: DocModel, sel: DocSelection, rows: number, cols: number, makeId: () => string = newId): Edit {
  const story = doc.stories.get(sel.story)!;
  const { from } = selectionRange(sel);
  const para = paragraphAt(story, from);
  const empty = para.start === para.end;
  const props = (story.attrAt(para.end) as ParaProps | undefined) ?? {};
  const s = doc.props.section;
  const width = Math.max(72, s.pageWidth - s.marginLeft - s.marginRight - (props.indentLeft ?? 0) - (props.indentRight ?? 0)) || DEFAULT_WIDTH;
  const id = makeId();
  const data: TableData = {
    rows: Array.from({ length: rows }, () => ({ id: makeId() })),
    cols: Array.from({ length: cols }, () => ({ id: makeId(), width: Math.round((width / cols) * 100) / 100 })),
  };
  const ops: Op[] = [];
  let at: number;
  let content: Content;
  if (empty) {
    at = para.start;
    content = { text: OBJECT, objects: [[0, { kind: 'table', id }]], tables: { [id]: data } };
  } else {
    // After this paragraph: its mark, then the table in a paragraph of its own.
    at = para.end;
    content = { text: `${PARA}${OBJECT}`, objects: [[1, { kind: 'table', id }]], tables: { [id]: data } };
    if (!isEmptyObject(props)) content.paras = [[0, props]];
  }
  ops.push({ type: 'insert', story: sel.story, at, content });
  // The table's own paragraph (the old mark, now after it) is a plain one.
  const patch = replacingPatch(props, {});
  if (!isEmptyObject(patch)) ops.push({ type: 'formatParagraphs', story: sel.story, at: para.end + content.text.length, runs: [[1, patch]] });
  return { op: batch(ops), selection: caretAt(cellStoryId(id, data.rows[0]!.id, data.cols[0]!.id), 0) };
}

export function insertRows(doc: DocModel, tableId: string, at: number, count = 1, makeId: () => string = newId): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  // New rows copy the formatting of the row they are inserted next to.
  const source = t.rows[Math.min(at, t.rows.length - 1)] ?? t.rows[0];
  const items = Array.from({ length: count }, () => ({ id: makeId(), ...(source?.height ? { height: source.height } : {}) }));
  const cells: Record<string, CellProps> = {};
  if (source) {
    for (const c of t.cols) {
      const p = t.cells?.[cellKey(source.id, c.id)];
      if (!p) continue;
      const format = { ...p };
      delete format.rowSpan;
      delete format.colSpan;
      if (!isEmptyObject(format)) for (const it of items) cells[cellKey(it.id, c.id)] = format;
    }
  }
  return { type: 'insertTableDims', table: tableId, axis: 'row', at: Math.max(0, Math.min(at, t.rows.length)), items, ...(isEmptyObject(cells) ? {} : { cells }) };
}

/** Inserts columns; the table keeps its width (the other columns give up some). */
export function insertCols(doc: DocModel, tableId: string, at: number, count = 1, makeId: () => string = newId): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  const total = t.cols.reduce((n, c) => n + c.width, 0);
  const n = t.cols.length + count;
  const width = Math.round((total / n) * 100) / 100;
  const scale = (total - width * count) / total;
  const items = Array.from({ length: count }, () => ({ id: makeId(), width }));
  return batch([
    { type: 'setTableDims', table: tableId, axis: 'col', dims: t.cols.map((c) => [c.id, { width: Math.max(10, Math.round(c.width * scale * 100) / 100) }]) },
    { type: 'insertTableDims', table: tableId, axis: 'col', at: Math.max(0, Math.min(at, t.cols.length)), items },
  ]);
}

/** Deletes rows (or columns); deleting all of them deletes the table. */
export function deleteDims(doc: DocModel, tableId: string, axis: 'row' | 'col', at: number, count: number): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  const dims = axis === 'row' ? t.rows : t.cols;
  if (at <= 0 && at + count >= dims.length) return deleteTable(doc, tableId);
  const ops: Op[] = [];
  if (axis === 'col') {
    // The remaining columns take up the width that goes.
    const total = t.cols.reduce((n, c) => n + c.width, 0);
    const removed = t.cols.slice(at, at + count).reduce((n, c) => n + c.width, 0);
    const scale = total / Math.max(1, total - removed);
    ops.push({ type: 'deleteTableDims', table: tableId, axis, at, count });
    const keep = t.cols.filter((_, i) => i < at || i >= at + count);
    ops.push({ type: 'setTableDims', table: tableId, axis: 'col', dims: keep.map((c) => [c.id, { width: Math.round(c.width * scale * 100) / 100 }]) });
    return batch(ops);
  }
  return { type: 'deleteTableDims', table: tableId, axis, at, count };
}

export function deleteTable(doc: DocModel, tableId: string): Op {
  const where = findTable(doc, tableId);
  if (!where) return NOOP;
  const story = doc.stories.get(where.story)!;
  // A table alone in its paragraph goes with the paragraph (unless it is the story's last).
  const para = paragraphAt(story, where.pos);
  const alone = para.start === where.pos && para.end === where.pos + 1 && para.end < story.length - 1;
  return { type: 'delete', story: where.story, from: where.pos, to: alone ? where.pos + 2 : where.pos + 1 };
}

/**
 * Merges the rectangle of cells into its top-left one. Text in the other
 * cells moves into it (one paragraph after another), as in Google Docs.
 */
export function mergeCells(doc: DocModel, tableId: string, r1: number, c1: number, r2: number, c2: number): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  const rect = coverMerges(t, {
    top: Math.max(0, Math.min(r1, r2)),
    left: Math.max(0, Math.min(c1, c2)),
    bottom: Math.min(t.rows.length - 1, Math.max(r1, r2)),
    right: Math.min(t.cols.length - 1, Math.max(c1, c2)),
  });
  const { top, left } = rect;
  if (top === rect.bottom && left === rect.right) return NOOP;
  const anchorId = cellStoryId(tableId, t.rows[top]!.id, t.cols[left]!.id);
  if (!doc.stories.has(anchorId)) return NOOP;
  const ops = moveCellText(doc, t, tableId, rect, anchorId);
  ops.push({ type: 'setTableCells', table: tableId, cells: mergePatches(t, rect) });
  return batch(ops);
}

export interface CellRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The cells a merged cell covers (a single cell's own position when it is not merged). */
export function mergedBlock(t: TableData, row: number, col: number): CellRect {
  const a = mergeAnchor(t, row, col);
  const p = t.cells?.[cellKey(t.rows[a.row]!.id, t.cols[a.col]!.id)];
  return { top: a.row, left: a.col, bottom: Math.min(t.rows.length - 1, a.row + (p?.rowSpan ?? 1) - 1), right: Math.min(t.cols.length - 1, a.col + (p?.colSpan ?? 1) - 1) };
}

/** The rectangle grown until every merge it touches lies wholly inside it, so merging never cuts one in two. */
function coverMerges(t: TableData, rect: CellRect): CellRect {
  const out = { ...rect };
  for (let grown = true; grown; ) {
    grown = false;
    for (let r = out.top; r <= out.bottom; r++) {
      for (let c = out.left; c <= out.right; c++) {
        const b = mergedBlock(t, r, c);
        if (b.top < out.top || b.left < out.left || b.bottom > out.bottom || b.right > out.right) {
          out.top = Math.min(out.top, b.top);
          out.left = Math.min(out.left, b.left);
          out.bottom = Math.max(out.bottom, b.bottom);
          out.right = Math.max(out.right, b.right);
          grown = true;
        }
      }
    }
  }
  return out;
}

/** The cells of a rectangle other than its top-left one, in reading order. */
function otherCells(t: TableData, rect: CellRect): { row: string; col: string }[] {
  const out: { row: string; col: string }[] = [];
  for (let r = rect.top; r <= rect.bottom; r++) {
    for (let c = rect.left; c <= rect.right; c++) if (r !== rect.top || c !== rect.left) out.push({ row: t.rows[r]!.id, col: t.cols[c]!.id });
  }
  return out;
}

/** Ops moving the text of the other cells into the top-left one, each cell's as paragraphs of its own. */
function moveCellText(doc: DocModel, t: TableData, tableId: string, rect: CellRect, anchorId: string): Op[] {
  const ops: Op[] = [];
  let end = doc.stories.get(anchorId)!.length - 1;
  for (const cell of otherCells(t, rect)) {
    const sid = cellStoryId(tableId, cell.row, cell.col);
    const s = doc.stories.get(sid);
    if (!s || s.length <= 1) continue;
    const moved = doc.extract(sid, 0, s.length - 1);
    const piece = end === 0 ? moved : asNewParagraph(moved);
    ops.push({ type: 'delete', story: sid, from: 0, to: s.length - 1 });
    ops.push({ type: 'insert', story: anchorId, at: end, content: piece });
    end += piece.text.length;
  }
  return ops;
}

/** Content behind a paragraph mark of its own (joined after existing text). */
function asNewParagraph(moved: Content): Content {
  const piece: Content = { ...moved, text: PARA + moved.text, paras: shiftParas(moved, 1), objects: moved.objects?.map(([o, d]) => [o + 1, d]) };
  if (moved.runs) piece.runs = [[1, {}], ...moved.runs];
  else delete piece.runs;
  return piece;
}

/** Spans for the top-left cell; merges inside the rectangle are absorbed into it. */
function mergePatches(t: TableData, rect: CellRect): [string, Patch<CellProps>][] {
  const rows = rect.bottom - rect.top + 1;
  const cols = rect.right - rect.left + 1;
  const cells: [string, Patch<CellProps>][] = [[cellKey(t.rows[rect.top]!.id, t.cols[rect.left]!.id), { rowSpan: rows > 1 ? rows : null, colSpan: cols > 1 ? cols : null }]];
  for (const cell of otherCells(t, rect)) {
    const key = cellKey(cell.row, cell.col);
    if (t.cells?.[key]?.rowSpan || t.cells?.[key]?.colSpan) cells.push([key, { rowSpan: null, colSpan: null }]);
  }
  return cells;
}

function shiftParas(content: Content, by: number): Content['paras'] {
  const paras = content.paras?.map(([o, p]): [number, ParaProps] => [o + by, p]);
  return paras?.length ? paras : undefined;
}

/** Splits a merged cell back into single cells (their text stays in the top-left one). */
export function unmergeCell(doc: DocModel, tableId: string, row: number, col: number): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  const anchor = mergeAnchor(t, row, col);
  const key = cellKey(t.rows[anchor.row]!.id, t.cols[anchor.col]!.id);
  const p = t.cells?.[key];
  if (!p?.rowSpan && !p?.colSpan) return NOOP;
  return { type: 'setTableCells', table: tableId, cells: [[key, { rowSpan: null, colSpan: null }]] };
}

/** Moves the border after column `col` by `delta` points; the column after it gives or takes the space. */
export function resizeColumn(doc: DocModel, tableId: string, col: number, delta: number): Op {
  const t = doc.tables.get(tableId);
  const a = t?.cols[col];
  if (!t || !a) return NOOP;
  const b = t.cols[col + 1];
  const min = 18;
  if (!b) {
    // The last column: the table gets wider or narrower.
    return { type: 'setTableDims', table: tableId, axis: 'col', dims: [[a.id, { width: Math.max(min, round(a.width + delta)) }]] };
  }
  const d = Math.max(min - a.width, Math.min(delta, b.width - min));
  return {
    type: 'setTableDims',
    table: tableId,
    axis: 'col',
    dims: [
      [a.id, { width: round(a.width + d) }],
      [b.id, { width: round(b.width - d) }],
    ],
  };
}

/** Gives the columns between `from` and `to` equal widths (their total stays). */
export function distributeColumns(doc: DocModel, tableId: string, from = 0, to?: number): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  const cols = t.cols.slice(from, (to ?? t.cols.length - 1) + 1);
  const total = cols.reduce((n, c) => n + c.width, 0);
  const w = round(total / cols.length);
  return { type: 'setTableDims', table: tableId, axis: 'col', dims: cols.map((c) => [c.id, { width: w }]) };
}

export function setRowHeight(doc: DocModel, tableId: string, row: number, height: number | null): Op {
  const r = doc.tables.get(tableId)?.rows[row];
  if (!r) return NOOP;
  return { type: 'setTableDims', table: tableId, axis: 'row', dims: [[r.id, { height: height === null ? null : Math.max(6, round(height)) }]] };
}

/** Marks rows from the top as header rows (repeated on every page). */
export function setHeaderRows(doc: DocModel, tableId: string, count: number): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  return { type: 'setTableDims', table: tableId, axis: 'row', dims: t.rows.map((r, i) => [r.id, { header: i < count ? true : null }]) };
}

/** Patches the cells of a rectangle (background, borders, vertical alignment, padding). */
export function formatCells(doc: DocModel, tableId: string, r1: number, c1: number, r2: number, c2: number, patch: Patch<Omit<CellProps, 'rowSpan' | 'colSpan'>>): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  const cells: [string, Patch<CellProps>][] = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      const row = t.rows[r];
      const col = t.cols[c];
      if (row && col) cells.push([cellKey(row.id, col.id), patch]);
    }
  }
  return cells.length ? { type: 'setTableCells', table: tableId, cells } : NOOP;
}

export function formatTable(tableId: string, patch: Patch<TableProps>): Op {
  return { type: 'setTable', table: tableId, patch };
}

/** Empties the cells of a rectangle (Delete over a cell selection). */
export function clearCells(doc: DocModel, tableId: string, r1: number, c1: number, r2: number, c2: number): Op {
  const t = doc.tables.get(tableId);
  if (!t) return NOOP;
  const ops: Op[] = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      const sid = cellStoryId(tableId, t.rows[r]!.id, t.cols[c]!.id);
      const s = doc.stories.get(sid);
      if (s && s.length > 1) ops.push({ type: 'delete', story: sid, from: 0, to: s.length - 1 });
    }
  }
  return batch(ops);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
