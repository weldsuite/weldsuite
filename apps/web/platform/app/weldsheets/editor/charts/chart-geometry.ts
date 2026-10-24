/**
 * Where charts are on the grid canvas, what the pointer is on, and the chart
 * a move or resize leaves behind. A chart is anchored to a cell plus an
 * offset, so it scrolls with that cell; one anchored in the frozen panes
 * stays put.
 */

import { MAX_CHART_SIZE, MIN_CHART_SIZE, type Chart, type ChartAnchor, type Sheet } from '@weldsuite/sheets-engine';
import { colLeft, rowTop, type GridLayout, type Rect } from '../grid/geometry';

export type ChartHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const CHART_HANDLES: ChartHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Half the size of a resize handle, and how far off it a press still grabs it. */
export const HANDLE_RADIUS = 4;
const HANDLE_GRAB = 6;

export function chartRect(layout: GridLayout, sheet: Sheet, chart: Chart): Rect {
  const { row, col, dx, dy } = chart.anchor;
  return { x: colLeft(layout, sheet, col) + dx, y: rowTop(layout, sheet, row) + dy, w: chart.width, h: chart.height };
}

/** Where a chart may draw: the panes past the frozen ones, and the frozen ones too when it is anchored there. */
export function chartClip(layout: GridLayout, chart: Chart): Rect {
  const x = chart.anchor.col < layout.frozenCols ? layout.rowHeaderWidth : layout.rowHeaderWidth + layout.frozenWidth;
  const y = chart.anchor.row < layout.frozenRows ? layout.colHeaderHeight : layout.colHeaderHeight + layout.frozenHeight;
  return { x, y, w: Math.max(0, layout.width - x), h: Math.max(0, layout.height - y) };
}

/** Centre of each resize handle on a chart's frame. */
export function handleCenter(rect: Rect, handle: ChartHandle): [number, number] {
  return [edge(rect.x, rect.w, handle.includes('w'), handle.includes('e')), edge(rect.y, rect.h, handle.includes('n'), handle.includes('s'))];
}

function edge(start: number, size: number, low: boolean, high: boolean): number {
  if (low) return start;
  if (high) return start + size;
  return start + size / 2;
}

export const HANDLE_CURSOR: Record<ChartHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * The chart at canvas (x, y), topmost first; on the picked chart, the resize
 * handle there too.
 */
export function chartAt(
  layout: GridLayout,
  sheet: Sheet,
  x: number,
  y: number,
  selected: string | null,
): { chart: Chart; handle?: ChartHandle } | null {
  const picked = selected ? sheet.charts.find((c) => c.id === selected) : undefined;
  if (picked && inside(chartClip(layout, picked), x, y)) {
    const rect = chartRect(layout, sheet, picked);
    const handle = CHART_HANDLES.find((h) => {
      const [hx, hy] = handleCenter(rect, h);
      return Math.abs(hx - x) <= HANDLE_GRAB && Math.abs(hy - y) <= HANDLE_GRAB;
    });
    if (handle) return { chart: picked, handle };
  }
  for (let i = sheet.charts.length - 1; i >= 0; i--) {
    const chart = sheet.charts[i]!;
    if (inside(chartClip(layout, chart), x, y) && inside(chartRect(layout, sheet, chart), x, y)) return { chart };
  }
  return null;
}

/**
 * The chart after the pointer moved (dx, dy) from where a move (no handle) or
 * a resize started. Positions are worked out in sheet pixels, so the anchor
 * lands on the cell under the chart's new corner whatever the scroll.
 */
export function draggedChart(sheet: Sheet, chart: Chart, handle: ChartHandle | null, dx: number, dy: number): Chart {
  let left = sheet.cols.offsetOf(chart.anchor.col) + chart.anchor.dx;
  let top = sheet.rows.offsetOf(chart.anchor.row) + chart.anchor.dy;
  let { width, height } = chart;
  if (handle === null) {
    left += dx;
    top += dy;
  } else {
    if (handle.includes('e')) width = clampSize(width + dx);
    if (handle.includes('s')) height = clampSize(height + dy);
    if (handle.includes('w')) {
      const next = clampSize(width - dx);
      left += width - next;
      width = next;
    }
    if (handle.includes('n')) {
      const next = clampSize(height - dy);
      top += height - next;
      height = next;
    }
  }
  const maxLeft = sheet.cols.offsetOf(sheet.colCount) - MIN_CHART_SIZE;
  const maxTop = sheet.rows.offsetOf(sheet.rowCount) - MIN_CHART_SIZE;
  const col = cellAt(sheet, 'col', Math.min(Math.max(0, left), maxLeft));
  const row = cellAt(sheet, 'row', Math.min(Math.max(0, top), maxTop));
  const anchor: ChartAnchor = { row: row.index, col: col.index, dx: col.offset, dy: row.offset };
  return { ...chart, anchor, width, height };
}

function clampSize(size: number): number {
  return Math.round(Math.min(MAX_CHART_SIZE, Math.max(MIN_CHART_SIZE, size)));
}

/** The cell on `axis` at sheet offset `at`, and the rest of the offset into it. */
function cellAt(sheet: Sheet, axis: 'row' | 'col', at: number): { index: number; offset: number } {
  const dims = axis === 'row' ? sheet.rows : sheet.cols;
  const count = axis === 'row' ? sheet.rowCount : sheet.colCount;
  const index = Math.min(count - 1, dims.indexAt(Math.round(at)));
  return { index, offset: Math.max(0, Math.min(MAX_CHART_SIZE, Math.round(at - dims.offsetOf(index)))) };
}

/** Whether two charts sit in the same place at the same size. */
export function samePlace(a: Chart, b: Chart): boolean {
  return (
    a.anchor.row === b.anchor.row &&
    a.anchor.col === b.anchor.col &&
    a.anchor.dx === b.anchor.dx &&
    a.anchor.dy === b.anchor.dy &&
    a.width === b.width &&
    a.height === b.height
  );
}
