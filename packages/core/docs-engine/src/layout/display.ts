/**
 * What to draw on a page, in page coordinates (points from the top-left):
 * text runs on their baselines, rectangles (highlights, shading, cell
 * backgrounds), lines (borders, rules, the footnote separator), images and
 * list markers. The editor's DOM renderer and the PDF writer both draw from
 * this, so the screen and the export agree.
 */

import { DEFAULT_CELL_PADDING, cellHeight, cellContentOffset } from './table';
import type { DocLayout } from './document-layout';
import type { CellLayout, LineLayout, PageArea, PageLayout, ParagraphLayout, PlacedItem, RunLayout, RunStyle, TableLayout } from './types';
import type { BorderLine } from '../model/styles';
import type { ImageObject } from '../model/objects';

export type DisplayItem =
  | {
      kind: 'text';
      x: number;
      baseline: number;
      text: string;
      style: RunStyle;
      width: number;
      /** Extra space after each space character (justified lines). */
      wordSpacing?: number;
      ascent: number;
      descent: number;
      story: string;
      /** Document positions of the run. */
      start: number;
      end: number;
    }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; fill: string; radius?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: string; style?: BorderLine['style'] }
  | { kind: 'image'; x: number; y: number; width: number; height: number; image: ImageObject }
  | { kind: 'checkbox'; x: number; y: number; size: number; checked: boolean; color: string };

export interface DisplayOptions {
  /** Shown by `title` fields. */
  title?: string;
  /** Shown by `date` fields (default: today). */
  date?: Date;
  locale?: string;
}

const DEFAULT_BORDER: BorderLine = { width: 0.75, color: '#000000' };

export function pageDisplay(dl: DocLayout, page: PageLayout, options: DisplayOptions = {}): DisplayItem[] {
  const out: DisplayItem[] = [];
  const ctx: Ctx = { dl, page, out, options, pages: dl.pages.length };
  const f = page.footnotes;
  // The short rule above the footnotes.
  if (f) out.push({ kind: 'line', x1: f.x, y1: f.y + 6, x2: f.x + Math.min(144, f.width / 3), y2: f.y + 6, width: 0.5, color: '#000000' });
  for (const area of pageAreas(page)) {
    for (const item of area.items) drawPlaced(ctx, item);
  }
  return out;
}

/** The page's columns, then its header, footer and footnotes (those it has). */
function pageAreas(page: PageLayout): PageArea[] {
  const areas: PageArea[] = [...page.columns];
  for (const area of [page.header, page.footer, page.footnotes]) if (area) areas.push(area);
  return areas;
}

/** One placed block: lines of a paragraph, or rows of a table (with its repeated header rows). */
function drawPlaced(ctx: Ctx, item: PlacedItem): void {
  const layout = item.entry.layout;
  const block = layout?.blocks[item.block];
  if (!layout || !block) return;
  if (block.kind === 'lines') {
    drawLines(ctx, item.story, item.entry.start, layout, block.lines, item.from, item.to, item.x, item.y, item.width);
    return;
  }
  const rows = item.kind === 'rows' ? [...item.repeat] : [];
  for (let r = item.from; r < item.to; r++) rows.push(r);
  drawTable(ctx, block.table, rows, item.x, item.y);
}

interface Ctx {
  dl: DocLayout;
  page: PageLayout;
  out: DisplayItem[];
  options: DisplayOptions;
  pages: number;
}

function drawLines(
  ctx: Ctx,
  story: string,
  paraStart: number,
  layout: ParagraphLayout,
  lines: LineLayout[],
  from: number,
  to: number,
  x: number,
  y: number,
  width: number,
): void {
  const props = layout.props;
  let height = 0;
  for (let i = from; i < to; i++) height += lines[i]!.height;
  // Paragraph shading and borders span its indents.
  const left = x + (props.indentLeft ?? 0);
  const right = x + width - (props.indentRight ?? 0);
  if (props.shading) ctx.out.push({ kind: 'rect', x: left, y, width: right - left, height, fill: props.shading });
  const b = props.borders;
  if (b?.top && from === 0) border(ctx, b.top, left, y, right, y);
  if (b?.bottom && to === lines.length) border(ctx, b.bottom, left, y + height, right, y + height);
  if (b?.left) border(ctx, b.left, left, y, left, y + height);
  if (b?.right) border(ctx, b.right, right, y, right, y + height);

  let ly = y;
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    drawLine(ctx, story, paraStart, line, x, ly, width);
    ly += line.height;
  }
}

function drawLine(ctx: Ctx, story: string, paraStart: number, line: LineLayout, x: number, top: number, areaWidth: number): void {
  const baseline = top + line.ascent;
  if (line.rule) {
    const y = top + line.height / 2;
    ctx.out.push({ kind: 'line', x1: x, y1: y, x2: x + areaWidth, y2: y, width: 1, color: '#a0a0a0' });
  }
  if (line.marker) drawMarker(ctx, line.marker, x, baseline, { story, start: paraStart + line.start, end: paraStart + line.start });
  for (const run of line.runs) {
    const pos: RunPlace = { story, start: paraStart + run.start, end: paraStart + run.end };
    drawRun(ctx, run, x + line.x + run.x, baseline, pos);
  }
}

/** The story and document positions a drawn run stands for. */
interface RunPlace {
  story: string;
  start: number;
  end: number;
}

/** Tab leader characters. */
const LEADER_CHARS: Record<string, string> = { dot: '.', hyphen: '-' };

/** A list marker: a tick box for a checklist, else its text (bullet or number). */
function drawMarker(ctx: Ctx, m: NonNullable<LineLayout['marker']>, x: number, baseline: number, place: RunPlace): void {
  if (m.text === '☐' || m.text === '☑') {
    const size = m.style.font.size * 0.9;
    ctx.out.push({ kind: 'checkbox', x: x + m.x, y: baseline - size * 0.85, size, checked: m.text === '☑', color: m.style.color });
    return;
  }
  const metrics = ctx.dl.measurer.metrics(m.style.font);
  ctx.out.push({ kind: 'text', x: x + m.x, baseline, text: m.text, style: m.style, width: m.width, ascent: metrics.ascent, descent: metrics.descent, ...place });
}

/** One run of a line at `rx`: text (with its highlight), a tab's leader, or an object. */
function drawRun(ctx: Ctx, run: RunLayout, rx: number, baseline: number, place: RunPlace): void {
  const bl = baseline - (run.style.baselineShift ?? 0);
  if (run.kind === 'text' && run.text) drawTextRun(ctx, run, run.text, rx, bl, place);
  else if (run.kind === 'tab' && run.leader && run.leader !== 'none' && run.width > 0) drawLeader(ctx, run, LEADER_CHARS[run.leader] ?? '_', rx, bl, place);
  else if (run.kind === 'object' && run.object) drawObject(ctx, run, run.object, rx, baseline, bl, place);
}

function drawTextRun(ctx: Ctx, run: RunLayout, text: string, rx: number, bl: number, place: RunPlace): void {
  const style = run.style;
  const metrics = ctx.dl.measurer.metrics(style.font);
  if (style.highlight) ctx.out.push({ kind: 'rect', x: rx, y: bl - metrics.ascent, width: run.width, height: metrics.ascent + metrics.descent, fill: style.highlight });
  const item: DisplayItem = { kind: 'text', x: rx, baseline: bl, text, style, width: run.width, ascent: metrics.ascent, descent: metrics.descent, ...place };
  if (run.wordSpacing) item.wordSpacing = run.wordSpacing;
  ctx.out.push(item);
}

/** A tab leader: as many dots (hyphens, underscores) as fit, flush right. */
function drawLeader(ctx: Ctx, run: RunLayout, ch: string, rx: number, bl: number, place: RunPlace): void {
  const style = run.style;
  const metrics = ctx.dl.measurer.metrics(style.font);
  const w = ctx.dl.measurer.measure(ch, style.font) || 1;
  const n = Math.max(0, Math.floor((run.width - w) / w));
  if (!n) return;
  ctx.out.push({ kind: 'text', x: rx + (run.width - n * w), baseline: bl, text: ch.repeat(n), style: { ...style, underline: false, strike: false }, width: n * w, ascent: metrics.ascent, descent: metrics.descent, ...place });
}

/** An inline object: an image, or a field or chip drawn as text (a chip on its grey pill). */
function drawObject(ctx: Ctx, run: RunLayout, obj: NonNullable<RunLayout['object']>, rx: number, baseline: number, bl: number, place: RunPlace): void {
  if (obj.kind === 'image') {
    ctx.out.push({ kind: 'image', x: rx, y: baseline - obj.height, width: obj.width, height: obj.height, image: obj });
    return;
  }
  if (run.text === undefined) return;
  const style = run.style;
  const metrics = ctx.dl.measurer.metrics(style.font);
  const text = obj.kind === 'field' ? fieldText(ctx, obj.field, obj.format) : run.text;
  const chip = obj.kind === 'chip';
  if (chip) {
    ctx.out.push({ kind: 'rect', x: rx, y: bl - metrics.ascent - 1, width: run.width, height: metrics.ascent + metrics.descent + 2, fill: '#e8eaed', radius: (metrics.ascent + metrics.descent) / 2 });
  }
  const pad = chip ? 6 : 0;
  ctx.out.push({ kind: 'text', x: rx + pad, baseline: bl, text, style, width: run.width - 2 * pad, ascent: metrics.ascent, descent: metrics.descent, ...place });
}

function fieldText(ctx: Ctx, field: string, format: string | undefined): string {
  switch (field) {
    case 'page':
      return ctx.page.label;
    case 'pages':
      return String(ctx.pages);
    case 'title':
      return ctx.options.title ?? '';
    case 'date': {
      const date = ctx.options.date ?? new Date();
      return new Intl.DateTimeFormat(ctx.options.locale ?? 'en', format === 'long' ? { dateStyle: 'long' } : { dateStyle: 'medium' }).format(date);
    }
    default:
      return '';
  }
}

function border(ctx: Ctx, line: BorderLine, x1: number, y1: number, x2: number, y2: number): void {
  if (!line.width) return;
  const item: DisplayItem = { kind: 'line', x1, y1, x2, y2, width: line.width, color: line.color };
  if (line.style) item.style = line.style;
  ctx.out.push(item);
}

function drawTable(ctx: Ctx, table: TableLayout, rows: number[], x: number, y: number): void {
  const tx = x + table.x;
  const defaultBorder = table.data.props?.border ?? DEFAULT_BORDER;
  let ry = y;
  for (const r of rows) {
    const row = table.rows[r]!;
    // Cells anchored here, plus merged cells from earlier rows when this row starts a page.
    const cells: { cell: CellLayout; top: number }[] = row.cells.map((cell) => ({ cell, top: ry }));
    if (r === rows[0]) cells.push(...mergedFromAbove(table, r, ry));
    for (const { cell, top } of cells) drawCell(ctx, table, cell, tx, top, defaultBorder, rows);
    ry += row.height;
  }
}

/** Cells of rows above `r` that are merged down into it, with where their top would be. */
function mergedFromAbove(table: TableLayout, r: number, ry: number): { cell: CellLayout; top: number }[] {
  const out: { cell: CellLayout; top: number }[] = [];
  for (let k = 0; k < r; k++) {
    for (const cell of table.rows[k]!.cells) {
      if (k + cell.rowSpan > r) out.push({ cell, top: ry - rowsBetween(table, k, r) });
    }
  }
  return out;
}

function rowsBetween(table: TableLayout, from: number, to: number): number {
  let h = 0;
  for (let r = from; r < to; r++) h += table.rows[r]!.height;
  return h;
}

function drawCell(ctx: Ctx, table: TableLayout, cell: CellLayout, tx: number, top: number, defaultBorder: BorderLine, rows: number[]): void {
  const x = tx + cell.x;
  const h = cellHeight(table, cell);
  if (cell.background) ctx.out.push({ kind: 'rect', x, y: top, width: cell.width, height: h, fill: cell.background });
  const data = table.data;
  const props = data.cells?.[`${data.rows[cell.rowIndex]!.id}:${data.cols[cell.colIndex]!.id}`];
  const b = props?.borders;
  border(ctx, b?.top ?? defaultBorder, x, top, x + cell.width, top);
  border(ctx, b?.bottom ?? defaultBorder, x, top + h, x + cell.width, top + h);
  border(ctx, b?.left ?? defaultBorder, x, top, x, top + h);
  border(ctx, b?.right ?? defaultBorder, x + cell.width, top, x + cell.width, top + h);
  // A merged cell split across pages shows its content where it starts.
  if (!rows.includes(cell.rowIndex)) return;
  const cx = x + (cell.padding ?? DEFAULT_CELL_PADDING);
  const cy = top + cellContentOffset(table, cell);
  for (const p of cell.paragraphs) {
    let by = cy + p.y;
    for (const block of p.layout.blocks) {
      if (block.kind === 'lines') {
        drawLines(ctx, cell.story, p.entry.start, p.layout, block.lines, 0, block.lines.length, cx, by, cell.width - 2 * cell.padding);
        for (const l of block.lines) by += l.height;
      } else {
        drawTable(ctx, block.table, block.table.rows.map((_, i) => i), cx, by);
        by += rowsBetween(block.table, 0, block.table.rows.length);
      }
    }
  }
}
