import type { AxisDims, Range, Sheet } from '@weldsuite/sheets-engine';

export const COL_HEADER_HEIGHT = 24;
const MIN_ROW_HEADER_WIDTH = 46;
/** Pixels within a header border that grab it for resizing. */
export const RESIZE_GRIP = 4;
/**
 * Browsers cap an element's size (around 16–33 million pixels); a million
 * 21px rows is 22 million. Scroll space past this is scaled.
 */
export const MAX_SCROLL_SIZE = 8_000_000;

/** One visible row or column: its index, canvas position and size in CSS pixels. */
export interface Segment {
  index: number;
  start: number;
  size: number;
}

export interface GridLayout {
  width: number;
  height: number;
  rowHeaderWidth: number;
  colHeaderHeight: number;
  frozenRows: number;
  frozenCols: number;
  /** Size of the frozen rows/columns, headers excluded. */
  frozenHeight: number;
  frozenWidth: number;
  /** Offset into the scrolling part of the sheet. */
  scrollX: number;
  scrollY: number;
  /** Visible rows and columns: frozen ones first, then the scrolled ones. */
  rows: Segment[];
  cols: Segment[];
}

export function rowHeaderWidth(rowCount: number): number {
  return Math.max(MIN_ROW_HEADER_WIDTH, String(rowCount).length * 8 + 18);
}

export function computeLayout(sheet: Sheet, width: number, height: number, scrollX: number, scrollY: number): GridLayout {
  const frozenRows = Math.min(sheet.freeze.rows, sheet.rowCount);
  const frozenCols = Math.min(sheet.freeze.cols, sheet.colCount);
  const headerWidth = rowHeaderWidth(sheet.rowCount);
  const frozenHeight = sheet.rows.offsetOf(frozenRows);
  const frozenWidth = sheet.cols.offsetOf(frozenCols);
  return {
    width,
    height,
    rowHeaderWidth: headerWidth,
    colHeaderHeight: COL_HEADER_HEIGHT,
    frozenRows,
    frozenCols,
    frozenHeight,
    frozenWidth,
    scrollX,
    scrollY,
    rows: visibleSegments(sheet.rows, sheet.rowCount, frozenRows, COL_HEADER_HEIGHT, frozenHeight, scrollY, height),
    cols: visibleSegments(sheet.cols, sheet.colCount, frozenCols, headerWidth, frozenWidth, scrollX, width),
  };
}

function visibleSegments(
  axis: AxisDims,
  count: number,
  frozen: number,
  header: number,
  frozenSize: number,
  scroll: number,
  viewport: number,
): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < frozen; i++) {
    const size = axis.sizeOf(i);
    if (size > 0) out.push({ index: i, start: header + axis.offsetOf(i), size });
  }
  const base = axis.offsetOf(frozen);
  let i = Math.max(frozen, axis.indexAt(base + scroll));
  let start = header + frozenSize + axis.offsetOf(i) - base - scroll;
  while (i < count && start < viewport) {
    const size = axis.sizeOf(i);
    if (size > 0) out.push({ index: i, start, size });
    start += size;
    i++;
  }
  return out;
}

/** Size of the scrolling part of the sheet (everything past the frozen panes). */
export function scrollContentSize(sheet: Sheet): { width: number; height: number } {
  return {
    width: sheet.cols.offsetOf(sheet.colCount) - sheet.cols.offsetOf(sheet.freeze.cols),
    height: sheet.rows.offsetOf(sheet.rowCount) - sheet.rows.offsetOf(sheet.freeze.rows),
  };
}

/** The scroll element's size for content of `size`, capped at MAX_SCROLL_SIZE. */
export function physicalScrollSize(size: number): number {
  return Math.min(size, MAX_SCROLL_SIZE);
}

/** scrollTop/scrollLeft → offset into the content, linear when the scroll space is capped. */
export function toLogicalScroll(physical: number, contentSize: number, viewport: number): number {
  const physicalSize = physicalScrollSize(contentSize);
  if (physicalSize === contentSize || physicalSize <= viewport) return physical;
  return (physical / (physicalSize - viewport)) * (contentSize - viewport);
}

export function toPhysicalScroll(logical: number, contentSize: number, viewport: number): number {
  const physicalSize = physicalScrollSize(contentSize);
  if (physicalSize === contentSize || contentSize <= viewport) return logical;
  return (logical / (contentSize - viewport)) * (physicalSize - viewport);
}

/** Canvas y of the top of `row`, whether or not it is on screen. */
export function rowTop(layout: GridLayout, sheet: Sheet, row: number): number {
  if (row < layout.frozenRows) return layout.colHeaderHeight + sheet.rows.offsetOf(row);
  return (
    layout.colHeaderHeight +
    layout.frozenHeight +
    sheet.rows.offsetOf(row) -
    sheet.rows.offsetOf(layout.frozenRows) -
    layout.scrollY
  );
}

export function colLeft(layout: GridLayout, sheet: Sheet, col: number): number {
  if (col < layout.frozenCols) return layout.rowHeaderWidth + sheet.cols.offsetOf(col);
  return (
    layout.rowHeaderWidth + layout.frozenWidth + sheet.cols.offsetOf(col) - sheet.cols.offsetOf(layout.frozenCols) - layout.scrollX
  );
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Canvas rectangle of a range (merged cells: pass the merge range). */
export function rangeRect(layout: GridLayout, sheet: Sheet, r: Range): Rect {
  const r2 = Math.min(r.r2, sheet.rowCount - 1);
  const c2 = Math.min(r.c2, sheet.colCount - 1);
  const x = colLeft(layout, sheet, r.c1);
  const y = rowTop(layout, sheet, r.r1);
  return {
    x,
    y,
    w: colLeft(layout, sheet, c2) + sheet.cols.sizeOf(c2) - x,
    h: rowTop(layout, sheet, r2) + sheet.rows.sizeOf(r2) - y,
  };
}

/** The four pane areas (frozen corner, frozen rows, frozen columns, body), as clip rectangles. */
export function panes(layout: GridLayout): Rect[] {
  const left = layout.rowHeaderWidth;
  const top = layout.colHeaderHeight;
  const fw = layout.frozenWidth;
  const fh = layout.frozenHeight;
  const out: Rect[] = [{ x: left + fw, y: top + fh, w: layout.width - left - fw, h: layout.height - top - fh }];
  if (fh > 0) out.push({ x: left + fw, y: top, w: layout.width - left - fw, h: fh });
  if (fw > 0) out.push({ x: left, y: top + fh, w: fw, h: layout.height - top - fh });
  if (fh > 0 && fw > 0) out.push({ x: left, y: top, w: fw, h: fh });
  return out;
}

export type HitArea = 'corner' | 'colHeader' | 'rowHeader' | 'cell';

export interface Hit {
  area: HitArea;
  row: number;
  col: number;
  /** Set when the pointer is on a header border: the row/column that border resizes. */
  resize?: { axis: 'row' | 'col'; index: number };
}

export function hitTest(layout: GridLayout, sheet: Sheet, x: number, y: number): Hit {
  const col = indexAtX(layout, sheet, x);
  const row = indexAtY(layout, sheet, y);
  if (y < layout.colHeaderHeight && x < layout.rowHeaderWidth) return { area: 'corner', row: 0, col: 0 };
  if (y < layout.colHeaderHeight) {
    const resize = borderNear(layout.cols, x);
    return resize === undefined ? { area: 'colHeader', row, col } : { area: 'colHeader', row, col, resize: { axis: 'col', index: resize } };
  }
  if (x < layout.rowHeaderWidth) {
    const resize = borderNear(layout.rows, y);
    return resize === undefined ? { area: 'rowHeader', row, col } : { area: 'rowHeader', row, col, resize: { axis: 'row', index: resize } };
  }
  return { area: 'cell', row, col };
}

function borderNear(segments: Segment[], p: number): number | undefined {
  for (const s of segments) {
    if (Math.abs(s.start + s.size - p) <= RESIZE_GRIP) return s.index;
  }
  return undefined;
}

function indexAtX(layout: GridLayout, sheet: Sheet, x: number): number {
  const inFrozen = x < layout.rowHeaderWidth + layout.frozenWidth;
  const offset = inFrozen
    ? Math.max(0, x - layout.rowHeaderWidth)
    : sheet.cols.offsetOf(layout.frozenCols) + (x - layout.rowHeaderWidth - layout.frozenWidth) + layout.scrollX;
  return Math.min(sheet.colCount - 1, sheet.cols.indexAt(offset));
}

function indexAtY(layout: GridLayout, sheet: Sheet, y: number): number {
  const inFrozen = y < layout.colHeaderHeight + layout.frozenHeight;
  const offset = inFrozen
    ? Math.max(0, y - layout.colHeaderHeight)
    : sheet.rows.offsetOf(layout.frozenRows) + (y - layout.colHeaderHeight - layout.frozenHeight) + layout.scrollY;
  return Math.min(sheet.rowCount - 1, sheet.rows.indexAt(offset));
}

/** Scroll offsets that bring (row, col) fully into view, or null when it already is. */
export function scrollIntoView(
  layout: GridLayout,
  sheet: Sheet,
  row: number,
  col: number,
): { scrollX: number; scrollY: number } | null {
  let { scrollX, scrollY } = layout;
  if (row >= layout.frozenRows) {
    const top = sheet.rows.offsetOf(row) - sheet.rows.offsetOf(layout.frozenRows);
    const bottom = top + sheet.rows.sizeOf(row);
    const visible = layout.height - layout.colHeaderHeight - layout.frozenHeight;
    if (top < scrollY) scrollY = top;
    else if (bottom > scrollY + visible) scrollY = bottom - visible;
  }
  if (col >= layout.frozenCols) {
    const left = sheet.cols.offsetOf(col) - sheet.cols.offsetOf(layout.frozenCols);
    const right = left + sheet.cols.sizeOf(col);
    const visible = layout.width - layout.rowHeaderWidth - layout.frozenWidth;
    if (left < scrollX) scrollX = left;
    else if (right > scrollX + visible) scrollX = right - visible;
  }
  if (scrollX === layout.scrollX && scrollY === layout.scrollY) return null;
  return { scrollX: Math.max(0, scrollX), scrollY: Math.max(0, scrollY) };
}
