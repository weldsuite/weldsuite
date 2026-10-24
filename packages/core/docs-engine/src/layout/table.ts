/**
 * Lays out a table: column widths (scaled down to fit), each cell's story at
 * its width, and row heights that fit the tallest cell. A merged cell spans
 * several rows; when it is taller than those rows, the last of them grows.
 */

import type { DocModel } from '../model/document';
import { cellKey, cellStoryId } from '../model/objects';
import type { CellLayout, ParaEntry, ParagraphLayout, RowLayout, TableLayout } from './types';

export interface StoryBlockLayout {
  paragraphs: { entry: ParaEntry; layout: ParagraphLayout; y: number }[];
  height: number;
}

export interface CellLayouter {
  layoutStory(storyId: string, width: number): StoryBlockLayout;
}

export const DEFAULT_CELL_PADDING = 5;
const MIN_ROW = 6;

export function layoutTable(doc: DocModel, tableId: string, width: number, cells: CellLayouter): TableLayout | null {
  const data = doc.tables.get(tableId);
  if (!data || !data.rows.length || !data.cols.length) return null;
  const props = data.props ?? {};

  // Columns keep their proportions and shrink to fit the space.
  const total = data.cols.reduce((n, c) => n + c.width, 0);
  const scale = total > width ? width / total : 1;
  const colWidths = data.cols.map((c) => c.width * scale);
  const colX: number[] = [];
  let acc = 0;
  for (const w of colWidths) {
    colX.push(acc);
    acc += w;
  }
  const tableWidth = acc;
  const x = props.align === 'center' ? (width - tableWidth) / 2 : props.align === 'right' ? width - tableWidth : Math.min(props.indent ?? 0, Math.max(0, width - tableWidth));

  // Which cells are covered by a merge (the first merge to claim a cell wins).
  const covered = new Set<string>();
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  data.rows.forEach((r, ri) =>
    data.cols.forEach((c, ci) => {
      const key = cellKey(r.id, c.id);
      if (covered.has(key)) return;
      const p = data.cells?.[key];
      const rowSpan = Math.max(1, Math.min(p?.rowSpan ?? 1, data.rows.length - ri));
      const colSpan = Math.max(1, Math.min(p?.colSpan ?? 1, data.cols.length - ci));
      spans.set(key, { rowSpan, colSpan });
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          if (dr || dc) covered.add(cellKey(data.rows[ri + dr]!.id, data.cols[ci + dc]!.id));
        }
      }
    }),
  );

  const rows: RowLayout[] = data.rows.map((r, ri) => ({
    index: ri,
    height: Math.max(MIN_ROW, r.height ?? 0),
    header: !!r.header,
    cantSplit: !!r.cantSplit,
    cells: [],
  }));

  data.rows.forEach((r, ri) =>
    data.cols.forEach((c, ci) => {
      const key = cellKey(r.id, c.id);
      if (covered.has(key)) return;
      const { rowSpan, colSpan } = spans.get(key)!;
      const p = data.cells?.[key] ?? {};
      const padding = p.padding ?? props.padding ?? DEFAULT_CELL_PADDING;
      let w = 0;
      for (let k = 0; k < colSpan; k++) w += colWidths[ci + k]!;
      const story = cellStoryId(tableId, r.id, c.id);
      const content = cells.layoutStory(story, Math.max(1, w - 2 * padding));
      const cell: CellLayout = {
        rowIndex: ri,
        colIndex: ci,
        rowSpan,
        colSpan,
        story,
        x: colX[ci]!,
        width: w,
        contentHeight: content.height,
        padding,
        paragraphs: content.paragraphs,
        vAlign: p.vAlign ?? 'top',
      };
      if (p.background) cell.background = p.background;
      rows[ri]!.cells.push(cell);
      if (rowSpan === 1) rows[ri]!.height = Math.max(rows[ri]!.height, content.height + 2 * padding);
    }),
  );

  // Merged cells taller than their rows make the last row taller.
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.rowSpan === 1) continue;
      let h = 0;
      for (let k = 0; k < cell.rowSpan; k++) h += rows[row.index + k]!.height;
      const need = cell.contentHeight + 2 * cell.padding;
      if (need > h) rows[row.index + cell.rowSpan - 1]!.height += need - h;
    }
  }

  let headerRows = 0;
  while (headerRows < rows.length - 1 && rows[headerRows]!.header) headerRows++;

  return { id: tableId, data, x, width: tableWidth, colX, colWidths, rows, headerRows };
}

/** Height of the cell box (its spanned rows). */
export function cellHeight(table: TableLayout, cell: CellLayout): number {
  let h = 0;
  for (let k = 0; k < cell.rowSpan; k++) h += table.rows[cell.rowIndex + k]?.height ?? 0;
  return h;
}

/** Offset of the cell's content from the cell box's top (vertical alignment). */
export function cellContentOffset(table: TableLayout, cell: CellLayout): number {
  const free = cellHeight(table, cell) - 2 * cell.padding - cell.contentHeight;
  if (free <= 0 || cell.vAlign === 'top') return cell.padding;
  return cell.padding + (cell.vAlign === 'middle' ? free / 2 : free);
}
