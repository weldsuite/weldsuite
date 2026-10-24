import { colToLetters, isError, type BorderSide, type CellStyle, type Range, type Scalar, type Sheet } from '@weldsuite/sheets-engine';
import type { SheetController } from '../model/sheet-controller';
import { primaryRange, type Selection } from '../model/selection';
import { panes, rangeRect, type GridLayout, type Rect, type Segment } from './geometry';
import type { GridTheme } from './theme';

const DEFAULT_FONT_FAMILY = 'Arial';
const DEFAULT_FONT_PT = 10;
const CELL_PADDING = 4;
/** How far left of the viewport to look for text that overflows into it. */
const OVERFLOW_LOOKBEHIND = 30;

type HAlign = 'left' | 'center' | 'right';

/** A formula reference to outline while a formula is being edited. */
export interface RefHighlight {
  range: Range;
  color: string;
}

/** Where someone else is on this sheet. */
export interface RemoteCursor {
  name: string;
  color: string;
  ranges: Range[];
  active: { row: number; col: number };
  /** Draw their name above their cell (briefly after they move, or on hover). */
  showName: boolean;
}

export interface RenderState {
  layout: GridLayout;
  controller: SheetController;
  theme: GridTheme;
  selection: Selection;
  /** The cell being edited (its text is drawn by the DOM editor). */
  editing: { row: number; col: number } | null;
  highlights: RefHighlight[];
  /** Other people in a co-edited sheet. */
  remote?: RemoteCursor[];
}

export function fontFor(style: CellStyle | undefined): string {
  const pt = style?.fontSize ?? DEFAULT_FONT_PT;
  const px = (pt * 4) / 3;
  const weight = style?.bold ? 'bold ' : '';
  const italic = style?.italic ? 'italic ' : '';
  return `${italic}${weight}${px}px ${style?.fontFamily ?? DEFAULT_FONT_FAMILY}`;
}

/** Draws the whole visible grid. The canvas is already scaled for devicePixelRatio. */
export function renderGrid(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { layout, theme } = state;
  ctx.fillStyle = theme.cellBackground;
  ctx.fillRect(0, 0, layout.width, layout.height);

  const rowGroups = splitFrozen(layout.rows, layout.frozenRows);
  const colGroups = splitFrozen(layout.cols, layout.frozenCols);
  for (const rows of rowGroups) {
    for (const cols of colGroups) {
      const clip = paneClip(layout, rows, cols);
      if (!clip) continue;
      withClip(ctx, clip, () => drawPane(ctx, state, rows, cols));
    }
  }
  for (const clip of panes(layout)) {
    withClip(ctx, clip, () => {
      drawFilterButtons(ctx, state);
      drawRemote(ctx, state, clip);
      drawHighlights(ctx, state);
      drawSelection(ctx, state);
    });
  }
  drawFreezeLines(ctx, state);
  drawHeaders(ctx, state);
}

function splitFrozen(segments: Segment[], frozen: number): Segment[][] {
  const head = segments.filter((s) => s.index < frozen);
  const body = segments.filter((s) => s.index >= frozen);
  return head.length ? [head, body] : [body];
}

function paneClip(layout: GridLayout, rows: Segment[], cols: Segment[]): Rect | null {
  const frozenRows = rows[0] !== undefined && rows[0].index < layout.frozenRows;
  const frozenCols = cols[0] !== undefined && cols[0].index < layout.frozenCols;
  const y = frozenRows ? layout.colHeaderHeight : layout.colHeaderHeight + layout.frozenHeight;
  const x = frozenCols ? layout.rowHeaderWidth : layout.rowHeaderWidth + layout.frozenWidth;
  const h = frozenRows ? layout.frozenHeight : layout.height - y;
  const w = frozenCols ? layout.frozenWidth : layout.width - x;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function withClip(ctx: CanvasRenderingContext2D, clip: Rect, draw: () => void): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.w, clip.h);
  ctx.clip();
  draw();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function drawPane(ctx: CanvasRenderingContext2D, state: RenderState, rows: Segment[], cols: Segment[]): void {
  if (rows.length === 0 || cols.length === 0) return;
  const sheet = state.controller.sheet;
  drawFills(ctx, state, rows, cols);
  if (sheet.props.gridlines !== false) drawGridlines(ctx, state.theme, rows, cols);
  const merges = visibleMerges(sheet, rows, cols);
  for (const m of merges) drawMergeBackground(ctx, state, m);
  drawTexts(ctx, state, rows, cols);
  for (const m of merges) drawCellText(ctx, state, m.r1, m.c1, rangeRect(state.layout, sheet, m), m);
  drawBorders(ctx, state, rows, cols);
}

/** The cell's style with any conditional formatting on top. */
function cellStyle(state: RenderState, row: number, col: number): CellStyle | undefined {
  const sheet = state.controller.sheet;
  const style = state.controller.engine.workbook.style(sheet, row, col);
  const conditional = state.controller.conditionalStyle(row, col);
  return conditional ? { ...style, ...conditional } : style;
}

function drawFills(ctx: CanvasRenderingContext2D, state: RenderState, rows: Segment[], cols: Segment[]): void {
  for (const r of rows) {
    for (const c of cols) {
      const fill = cellStyle(state, r.index, c.index)?.fill;
      if (!fill) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(c.start, r.start, c.size, r.size);
    }
  }
}

function drawGridlines(ctx: CanvasRenderingContext2D, theme: GridTheme, rows: Segment[], cols: Segment[]): void {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const left = cols[0]!.start;
  const right = cols[cols.length - 1]!.start + cols[cols.length - 1]!.size;
  ctx.strokeStyle = theme.gridline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const r of rows) {
    const y = Math.round(r.start + r.size) - 0.5;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  for (const c of cols) {
    const x = Math.round(c.start + c.size) - 0.5;
    ctx.moveTo(x, first.start);
    ctx.lineTo(x, last.start + last.size);
  }
  ctx.stroke();
}

function visibleMerges(sheet: Sheet, rows: Segment[], cols: Segment[]): Range[] {
  if (sheet.merges.length === 0) return [];
  const r1 = rows[0]!.index;
  const r2 = rows[rows.length - 1]!.index;
  const c1 = cols[0]!.index;
  const c2 = cols[cols.length - 1]!.index;
  return sheet.merges.filter((m) => m.r1 <= r2 && m.r2 >= r1 && m.c1 <= c2 && m.c2 >= c1);
}

function drawMergeBackground(ctx: CanvasRenderingContext2D, state: RenderState, m: Range): void {
  const rect = rangeRect(state.layout, state.controller.sheet, m);
  ctx.fillStyle = cellStyle(state, m.r1, m.c1)?.fill ?? state.theme.cellBackground;
  ctx.fillRect(rect.x, rect.y, rect.w - 1, rect.h - 1);
}

function drawTexts(ctx: CanvasRenderingContext2D, state: RenderState, rows: Segment[], cols: Segment[]): void {
  const sheet = state.controller.sheet;
  const firstCol = cols[0]!;
  for (const r of rows) {
    drawOverflowFromLeft(ctx, state, r, firstCol);
    for (const c of cols) {
      if (sheet.merges.length && sheet.mergeAt(r.index, c.index)) continue;
      drawCellText(ctx, state, r.index, c.index, { x: c.start, y: r.start, w: c.size, h: r.size });
    }
  }
}

/** Text in a cell left of the viewport may run into the first visible column. */
function drawOverflowFromLeft(ctx: CanvasRenderingContext2D, state: RenderState, r: Segment, first: Segment): void {
  const sheet = state.controller.sheet;
  if (first.index === 0 || first.index === state.layout.frozenCols) return;
  const engine = state.controller.engine;
  let x = first.start;
  for (let col = first.index - 1; col >= Math.max(0, first.index - OVERFLOW_LOOKBEHIND); col--) {
    x -= sheet.cols.sizeOf(col);
    if (engine.getValue(sheet.id, r.index, col) === null) continue;
    drawCellText(ctx, state, r.index, col, { x, y: r.start, w: sheet.cols.sizeOf(col), h: r.size });
    return;
  }
}

function horizontalAlign(style: CellStyle | undefined, value: Scalar): HAlign {
  if (style?.hAlign === 'center' || style?.hAlign === 'right' || style?.hAlign === 'left') return style.hAlign;
  if (typeof value === 'number') return 'right';
  if (typeof value === 'boolean' || isError(value)) return 'center';
  return 'left';
}

function drawCellText(ctx: CanvasRenderingContext2D, state: RenderState, row: number, col: number, cell: Rect, merge?: Range): void {
  const editing = state.editing;
  if (editing && editing.row === row && editing.col === col) return;
  const value = state.controller.engine.getValue(state.controller.sheet.id, row, col);
  const rect = drawValidationDecor(ctx, state, row, col, cell, value);
  if (!rect || value === null) return;
  const style = cellStyle(state, row, col);
  const display = state.controller.displayText(row, col);
  if (!display.text) return;

  ctx.font = fontFor(style);
  ctx.fillStyle = display.color ?? style?.color ?? defaultTextColor(style?.fill, state.theme);
  const align = horizontalAlign(style, value);
  const indent = (style?.indent ?? 0) * 9;

  if (style?.wrap === 'wrap') {
    drawWrapped(ctx, display.text, rect, align, style);
    return;
  }

  let text = display.text;
  const width = ctx.measureText(text).width;
  let clip = rect;
  if (width + CELL_PADDING * 2 + indent > rect.w) {
    if (typeof value === 'number') {
      text = '#'.repeat(Math.max(1, Math.floor((rect.w - CELL_PADDING * 2) / ctx.measureText('#').width)));
    } else if (style?.wrap !== 'clip' && !merge) {
      clip = overflowRect(state, row, col, rect, align, width + CELL_PADDING * 2 + indent);
    }
  }
  const y = textBaseline(rect, style);
  const x = alignedX(ctx, text, rect, align, indent);
  withClip(ctx, { x: clip.x, y: clip.y, w: clip.w - 1, h: clip.h - 1 }, () => {
    ctx.fillText(text, x, y);
    decorate(ctx, style, x, y, ctx.measureText(text).width);
  });
}

/** Text without a colour of its own: dark on a light fill in dark mode, where the theme's text is light. */
function defaultTextColor(fill: string | undefined, theme: GridTheme): string {
  const hex = fill && /^#([0-9a-f]{6})$/i.exec(fill)?.[1];
  if (!theme.dark || !hex) return theme.text;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const luminance = (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255;
  return luminance > 0.6 ? '#202124' : theme.text;
}

const CHECKBOX_SIZE = 14;
const DROPDOWN_WIDTH = 16;
/** Size of the filter button in a filter's header cells. */
export const FILTER_BUTTON = 16;

/** Where a cell's checkbox is (centred), for drawing and for clicks. */
export function checkboxRect(cell: Rect): Rect {
  return { x: cell.x + (cell.w - CHECKBOX_SIZE) / 2, y: cell.y + (cell.h - CHECKBOX_SIZE) / 2, w: CHECKBOX_SIZE, h: CHECKBOX_SIZE };
}

/** Where a list cell's dropdown arrow is (right edge), for drawing and for clicks. */
export function dropdownRect(cell: Rect): Rect {
  return { x: cell.x + cell.w - DROPDOWN_WIDTH - 1, y: cell.y, w: DROPDOWN_WIDTH, h: cell.h };
}

/** Where the filter button of a header cell is (right edge). */
export function filterButtonRect(cell: Rect): Rect {
  return { x: cell.x + cell.w - FILTER_BUTTON - 3, y: cell.y + (cell.h - FILTER_BUTTON) / 2, w: FILTER_BUTTON, h: FILTER_BUTTON };
}

/**
 * What a validation rule draws in a cell: a checkbox (which replaces the
 * text), a dropdown arrow, a mark on an invalid value. Returns the space left
 * for the text, or null when the cell is done.
 */
function drawValidationDecor(ctx: CanvasRenderingContext2D, state: RenderState, row: number, col: number, cell: Rect, value: Scalar): Rect | null {
  const rule = state.controller.validationAt(row, col);
  if (!rule) return cell;
  if (rule.criteria.type === 'checkbox' && (value === null || typeof value === 'boolean')) {
    drawCheckbox(ctx, state, cell, value === true);
    return null;
  }
  let rect = cell;
  if (rule.dropdown && (rule.criteria.type === 'list' || rule.criteria.type === 'listRange')) {
    drawDropdownArrow(ctx, state, cell);
    rect = { ...cell, w: Math.max(0, cell.w - DROPDOWN_WIDTH) };
  }
  if (value !== null && state.controller.isInvalid(row, col)) drawInvalidMark(ctx, cell);
  return rect;
}

function drawCheckbox(ctx: CanvasRenderingContext2D, state: RenderState, cell: Rect, checked: boolean): void {
  const box = checkboxRect(cell);
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = checked ? state.theme.selectionBorder : state.theme.headerText;
  ctx.fillStyle = checked ? state.theme.selectionBorder : state.theme.cellBackground;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, 2);
  ctx.fill();
  ctx.stroke();
  if (checked) {
    ctx.strokeStyle = state.theme.cellBackground;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(box.x + 3, box.y + 7);
    ctx.lineTo(box.x + 6, box.y + 10);
    ctx.lineTo(box.x + 11, box.y + 4);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDropdownArrow(ctx: CanvasRenderingContext2D, state: RenderState, cell: Rect): void {
  const r = dropdownRect(cell);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  ctx.fillStyle = state.theme.headerText;
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy - 2);
  ctx.lineTo(cx + 4, cy - 2);
  ctx.lineTo(cx, cy + 3);
  ctx.closePath();
  ctx.fill();
}

/** A red corner on a value its validation rule refuses. */
function drawInvalidMark(ctx: CanvasRenderingContext2D, cell: Rect): void {
  ctx.fillStyle = '#d93025';
  ctx.beginPath();
  ctx.moveTo(cell.x + cell.w - 8, cell.y);
  ctx.lineTo(cell.x + cell.w - 1, cell.y);
  ctx.lineTo(cell.x + cell.w - 1, cell.y + 7);
  ctx.closePath();
  ctx.fill();
}

/** Filter buttons in the header row of the sheet's filter; a column that filters gets a filled one. */
function drawFilterButtons(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const sheet = state.controller.sheet;
  const filter = sheet.filter;
  if (!filter) return;
  const row = filter.range.r1;
  for (const c of state.layout.cols) {
    if (c.index < filter.range.c1 || c.index > filter.range.c2) continue;
    const cell = rangeRect(state.layout, sheet, { r1: row, c1: c.index, r2: row, c2: c.index });
    if (cell.h <= 0) continue;
    const b = filterButtonRect(cell);
    const active = filter.columns.some((fc) => fc.col === c.index && (fc.hiddenValues?.length || fc.condition));
    ctx.fillStyle = active ? state.theme.selectionBorder : state.theme.headerBackground;
    ctx.strokeStyle = active ? state.theme.selectionBorder : state.theme.headerBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 3);
    ctx.fill();
    ctx.stroke();
    // A funnel: three lines, each shorter than the one above.
    ctx.strokeStyle = active ? state.theme.cellBackground : state.theme.headerText;
    ctx.lineWidth = 1.5;
    for (const [i, half] of [4.5, 3, 1.5].entries()) {
      const y = b.y + 5 + i * 3;
      ctx.beginPath();
      ctx.moveTo(b.x + b.w / 2 - half, y);
      ctx.lineTo(b.x + b.w / 2 + half, y);
      ctx.stroke();
    }
  }
}

function alignedX(ctx: CanvasRenderingContext2D, text: string, rect: Rect, align: HAlign, indent: number): number {
  const width = ctx.measureText(text).width;
  if (align === 'right') return rect.x + rect.w - CELL_PADDING - width - indent;
  if (align === 'center') return rect.x + (rect.w - width) / 2;
  return rect.x + CELL_PADDING + indent;
}

function textBaseline(rect: Rect, style: CellStyle | undefined): number {
  const px = ((style?.fontSize ?? DEFAULT_FONT_PT) * 4) / 3;
  if (style?.vAlign === 'top') return rect.y + CELL_PADDING + px * 0.85;
  if (style?.vAlign === 'middle') return rect.y + rect.h / 2 + px * 0.35;
  return rect.y + rect.h - CELL_PADDING - 1;
}

/** Underline and strikethrough, which canvas text has no setting for. */
function decorate(ctx: CanvasRenderingContext2D, style: CellStyle | undefined, x: number, y: number, width: number): void {
  if (!style?.underline && !style?.strike) return;
  const px = ((style.fontSize ?? DEFAULT_FONT_PT) * 4) / 3;
  ctx.strokeStyle = ctx.fillStyle as string;
  ctx.lineWidth = Math.max(1, px / 14);
  ctx.beginPath();
  if (style.underline) {
    ctx.moveTo(x, y + 2);
    ctx.lineTo(x + width, y + 2);
  }
  if (style.strike) {
    ctx.moveTo(x, y - px * 0.3);
    ctx.lineTo(x + width, y - px * 0.3);
  }
  ctx.stroke();
}

/** Text spills over empty neighbours in the direction it is aligned, as in Excel. */
function overflowRect(state: RenderState, row: number, col: number, rect: Rect, align: string, needed: number): Rect {
  const sheet = state.controller.sheet;
  const engine = state.controller.engine;
  const free = (c: number) => c >= 0 && c < sheet.colCount && engine.getValue(sheet.id, row, c) === null && !sheet.mergeAt(row, c);
  let left = rect.x;
  let right = rect.x + rect.w;
  const grow = (dir: 1 | -1) => {
    let c = col + dir;
    while (right - left < needed && free(c)) {
      if (dir > 0) right += sheet.cols.sizeOf(c);
      else left -= sheet.cols.sizeOf(c);
      c += dir;
    }
  };
  if (align === 'left') grow(1);
  else if (align === 'right') grow(-1);
  else {
    grow(1);
    grow(-1);
  }
  return { x: left, y: rect.y, w: right - left, h: rect.h };
}

function drawWrapped(ctx: CanvasRenderingContext2D, text: string, rect: Rect, align: HAlign, style: CellStyle | undefined): void {
  const px = ((style?.fontSize ?? DEFAULT_FONT_PT) * 4) / 3;
  const lineHeight = px * 1.25;
  const lines = wrapLines(ctx, text, rect.w - CELL_PADDING * 2);
  const total = lines.length * lineHeight;
  let y = rect.y + CELL_PADDING + px * 0.85;
  if (style?.vAlign !== 'top') {
    const offset = style?.vAlign === 'middle' ? (rect.h - total) / 2 : rect.h - total - CELL_PADDING;
    y = rect.y + Math.max(CELL_PADDING, offset) + px * 0.85;
  }
  withClip(ctx, { x: rect.x, y: rect.y, w: rect.w - 1, h: rect.h - 1 }, () => {
    for (const line of lines) {
      ctx.fillText(line, alignedX(ctx, line, rect, align, 0), y);
      y += lineHeight;
    }
  });
}

export function wrapLines(ctx: { measureText(t: string): { width: number } }, text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > width) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

const BORDER_WIDTH: Record<BorderSide['style'], number> = { thin: 1, dashed: 1, dotted: 1, medium: 2, thick: 3, double: 3 };
const BORDER_DASH: Record<BorderSide['style'], number[]> = {
  thin: [],
  dashed: [4, 2],
  dotted: [1, 2],
  medium: [],
  thick: [],
  double: [],
};

function drawBorders(ctx: CanvasRenderingContext2D, state: RenderState, rows: Segment[], cols: Segment[]): void {
  for (const r of rows) {
    for (const c of cols) {
      const style = cellStyle(state, r.index, c.index);
      if (!style || !(style.borderTop || style.borderRight || style.borderBottom || style.borderLeft)) continue;
      const { start: x, size: w } = c;
      const { start: y, size: h } = r;
      strokeSide(ctx, state, style.borderTop, x, y, x + w, y);
      strokeSide(ctx, state, style.borderBottom, x, y + h, x + w, y + h);
      strokeSide(ctx, state, style.borderLeft, x, y, x, y + h);
      strokeSide(ctx, state, style.borderRight, x + w, y, x + w, y + h);
    }
  }
}

function strokeSide(ctx: CanvasRenderingContext2D, state: RenderState, side: BorderSide | undefined, x1: number, y1: number, x2: number, y2: number): void {
  if (!side) return;
  ctx.strokeStyle = side.color ?? state.theme.text;
  ctx.lineWidth = BORDER_WIDTH[side.style];
  ctx.setLineDash(BORDER_DASH[side.style]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) - 0.5, Math.round(y1) - 0.5);
  ctx.lineTo(Math.round(x2) - 0.5, Math.round(y2) - 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------------------
// Selection, highlights, headers
// ---------------------------------------------------------------------------

function drawSelection(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { layout, theme, selection } = state;
  const sheet = state.controller.sheet;
  const active = selection.active;
  const activeRange = sheet.mergeAt(active.row, active.col) ?? { r1: active.row, c1: active.col, r2: active.row, c2: active.col };
  const activeRect = rangeRect(layout, sheet, activeRange);

  // Tint the selection, leaving the active cell clear (even-odd clip around it).
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, layout.width, layout.height);
  ctx.rect(activeRect.x, activeRect.y, activeRect.w, activeRect.h);
  ctx.clip('evenodd');
  ctx.fillStyle = theme.selectionFill;
  for (const range of selection.ranges) {
    const rect = rangeRect(layout, sheet, range);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();

  ctx.strokeStyle = theme.selectionBorder;
  ctx.lineWidth = 1;
  for (const range of selection.ranges) {
    const rect = rangeRect(layout, sheet, range);
    ctx.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.w, rect.h);
  }
  ctx.lineWidth = 2;
  ctx.strokeRect(activeRect.x, activeRect.y, activeRect.w - 1, activeRect.h - 1);
  // Fill handle on the primary range.
  const primary = rangeRect(layout, sheet, primaryRange(selection));
  ctx.fillStyle = theme.selectionBorder;
  ctx.fillRect(primary.x + primary.w - 4, primary.y + primary.h - 4, 6, 6);
}

/** Other people: a tint over their selection, their active cell outlined, their name above it. */
function drawRemote(ctx: CanvasRenderingContext2D, state: RenderState, pane: Rect): void {
  const sheet = state.controller.sheet;
  for (const cursor of state.remote ?? []) {
    ctx.fillStyle = `${cursor.color}1f`;
    for (const range of cursor.ranges) {
      const rect = rangeRect(state.layout, sheet, range);
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    const { row, col } = cursor.active;
    const rect = rangeRect(state.layout, sheet, sheet.mergeAt(row, col) ?? { r1: row, c1: col, r2: row, c2: col });
    ctx.strokeStyle = cursor.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x, rect.y, rect.w - 1, rect.h - 1);
    if (cursor.showName) drawNameFlag(ctx, cursor, rect, pane.y);
  }
}

const FLAG_HEIGHT = 14;

function drawNameFlag(ctx: CanvasRenderingContext2D, cursor: RemoteCursor, cell: Rect, paneTop: number): void {
  ctx.font = `10px ${DEFAULT_FONT_FAMILY}`;
  const width = ctx.measureText(cursor.name).width + 8;
  // Above the cell, or inside its top when the cell is at the top of its pane.
  const y = cell.y - FLAG_HEIGHT >= paneTop ? cell.y - FLAG_HEIGHT : cell.y;
  const x = cell.x + cell.w - width;
  ctx.fillStyle = cursor.color;
  ctx.fillRect(x, y, width, FLAG_HEIGHT);
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(cursor.name, x + 4, y + FLAG_HEIGHT / 2);
  ctx.restore();
}

function drawHighlights(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const sheet = state.controller.sheet;
  for (const h of state.highlights) {
    const rect = rangeRect(state.layout, sheet, h.range);
    ctx.fillStyle = `${h.color}22`;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = h.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(rect.x, rect.y, rect.w - 1, rect.h - 1);
    ctx.setLineDash([]);
  }
}

function drawFreezeLines(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { layout, theme } = state;
  ctx.fillStyle = theme.freezeLine;
  if (layout.frozenRows > 0) ctx.fillRect(0, layout.colHeaderHeight + layout.frozenHeight - 2, layout.width, 3);
  if (layout.frozenCols > 0) ctx.fillRect(layout.rowHeaderWidth + layout.frozenWidth - 2, 0, 3, layout.height);
}

function drawHeaders(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { layout, theme, selection } = state;
  const selectedCols = (c: number) => selection.ranges.some((r) => c >= r.c1 && c <= r.c2);
  const selectedRows = (r: number) => selection.ranges.some((s) => r >= s.r1 && r <= s.r2);

  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(0, 0, layout.width, layout.colHeaderHeight);
  ctx.fillRect(0, 0, layout.rowHeaderWidth, layout.height);
  ctx.font = `12px ${DEFAULT_FONT_FAMILY}`;
  ctx.textAlign = 'center';

  // Scrolled headers are clipped to the area past the frozen ones, so a row
  // sliding under the frozen rows doesn't draw over their numbers.
  const colsStart = layout.rowHeaderWidth + layout.frozenWidth;
  const rowsStart = layout.colHeaderHeight + layout.frozenHeight;
  for (const c of layout.cols) {
    const frozen = c.index < layout.frozenCols;
    const clip = frozen
      ? { x: layout.rowHeaderWidth, y: 0, w: layout.frozenWidth, h: layout.colHeaderHeight }
      : { x: colsStart, y: 0, w: layout.width - colsStart, h: layout.colHeaderHeight };
    const rect = { x: c.start, y: 0, w: c.size, h: layout.colHeaderHeight };
    withClip(ctx, clip, () => drawHeaderCell(ctx, theme, rect, colToLetters(c.index), selectedCols(c.index)));
  }
  for (const r of layout.rows) {
    const frozen = r.index < layout.frozenRows;
    const clip = frozen
      ? { x: 0, y: layout.colHeaderHeight, w: layout.rowHeaderWidth, h: layout.frozenHeight }
      : { x: 0, y: rowsStart, w: layout.rowHeaderWidth, h: layout.height - rowsStart };
    const rect = { x: 0, y: r.start, w: layout.rowHeaderWidth, h: r.size };
    withClip(ctx, clip, () => drawHeaderCell(ctx, theme, rect, String(r.index + 1), selectedRows(r.index)));
  }
  ctx.textAlign = 'start';

  // Corner and header edges.
  ctx.fillStyle = theme.headerBackground;
  ctx.fillRect(0, 0, layout.rowHeaderWidth, layout.colHeaderHeight);
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, layout.colHeaderHeight - 0.5);
  ctx.lineTo(layout.width, layout.colHeaderHeight - 0.5);
  ctx.moveTo(layout.rowHeaderWidth - 0.5, 0);
  ctx.lineTo(layout.rowHeaderWidth - 0.5, layout.height);
  ctx.stroke();
}

function drawHeaderCell(ctx: CanvasRenderingContext2D, theme: GridTheme, rect: Rect, label: string, selected: boolean): void {
  if (selected) {
    ctx.fillStyle = theme.headerSelected;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.strokeStyle = theme.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(rect.x + rect.w) - 0.5, rect.y);
  ctx.lineTo(Math.round(rect.x + rect.w) - 0.5, rect.y + rect.h);
  ctx.moveTo(rect.x, Math.round(rect.y + rect.h) - 0.5);
  ctx.lineTo(rect.x + rect.w, Math.round(rect.y + rect.h) - 0.5);
  ctx.stroke();
  if (rect.w < 8 || rect.h < 8) return;
  ctx.fillStyle = selected ? theme.headerSelectedText : theme.headerText;
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 4);
}
