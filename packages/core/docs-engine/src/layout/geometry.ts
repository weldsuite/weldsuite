/**
 * Geometry on a laid-out document, in page coordinates (points from the
 * page's top-left): where a position's caret is, which position is under a
 * point, and which rectangles a selection covers.
 *
 * Body, header, footer and footnote paragraphs were placed by pagination
 * (`DocLayout.placements`); a table cell's paragraphs are found through the
 * table that holds them, as deep as tables nest.
 */

import { LINE_BREAK, PARA } from '../model/chars';
import type { DocLayout } from './document-layout';
import { cellContentOffset } from './table';
import type { CellLayout, LineLayout, PageArea, ParaEntry, ParagraphLayout, PlacedItem, RunLayout, TableLayout } from './types';

export type Affinity = 'forward' | 'backward';

export interface CaretRect {
  page: number;
  x: number;
  y: number;
  height: number;
}

export interface HitResult {
  story: string;
  pos: number;
  /** A click past the end of a wrapped line: show the caret at that line's end. */
  affinity: Affinity;
}

export interface SelectionRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where block `bi` of a paragraph sits: one entry per page (or repeat) it appears on. */
interface Placed {
  page: number;
  /** Paragraph box's left edge. */
  x: number;
  /** Top of line (or row) `from`. */
  y: number;
  from: number;
  to: number;
}

// ---------------------------------------------------------------- locating

function entryAt(dl: DocLayout, story: string, pos: number): ParaEntry | null {
  const flow = dl.flow(story);
  if (!flow || !flow.entries.length) return null;
  const e = flow.entries[flow.indexAt(pos)]!;
  return e.layout ? e : null;
}

function blockTop(layout: ParagraphLayout, bi: number): number {
  let h = 0;
  for (let i = 0; i < bi; i++) {
    const b = layout.blocks[i]!;
    if (b.kind === 'lines') for (const l of b.lines) h += l.height;
    else for (const r of b.table.rows) h += r.height;
  }
  return h;
}

function rowsHeight(table: TableLayout, from: number, to: number): number {
  let h = 0;
  for (let r = from; r < to; r++) h += table.rows[r]?.height ?? 0;
  return h;
}

function placedBlock(dl: DocLayout, story: string, entry: ParaEntry, bi: number): Placed[] {
  const placements = dl.placements.get(entry);
  const layout = entry.layout!;
  if (placements) {
    return placements
      .filter((p) => p.item.block === bi)
      .map((p) => {
        const item = p.item;
        let y = item.y;
        if (item.kind === 'rows') {
          const b = layout.blocks[bi];
          if (b?.kind === 'table') for (const r of item.repeat) y += b.table.rows[r]!.height;
        }
        return { page: p.page, x: item.x, y, from: item.from, to: item.to };
      });
  }
  const owner = dl.storyOwners.get(story);
  if (!owner?.table || !owner.entry.layout) return [];
  const tb = owner.entry.layout.blocks.findIndex((b) => b.kind === 'table' && b.table.id === owner.table);
  const tableBlock = owner.entry.layout.blocks[tb];
  if (!tableBlock || tableBlock.kind !== 'table') return [];
  const table = tableBlock.table;
  const cell = findCell(table, story);
  if (!cell) return [];
  const para = cell.paragraphs.find((p) => p.entry === entry);
  if (!para) return [];
  const out: Placed[] = [];
  for (const p of placedBlock(dl, owner.story, owner.entry, tb)) {
    if (cell.rowIndex < p.from || cell.rowIndex >= p.to) continue;
    const y = p.y + rowsHeight(table, p.from, cell.rowIndex) + cellContentOffset(table, cell) + para.y + blockTop(layout, bi);
    const b = layout.blocks[bi]!;
    out.push({ page: p.page, x: p.x + table.x + cell.x + cell.padding, y, from: 0, to: b.kind === 'lines' ? b.lines.length : b.table.rows.length });
  }
  return out;
}

function findCell(table: TableLayout, story: string): CellLayout | undefined {
  for (const row of table.rows) for (const c of row.cells) if (c.story === story) return c;
  return undefined;
}

/** The lines block and line holding offset `off` of a paragraph. */
function lineOf(layout: ParagraphLayout, off: number, affinity: Affinity): { bi: number; li: number } | { bi: number; table: true } | null {
  for (let bi = 0; bi < layout.blocks.length; bi++) {
    const b = layout.blocks[bi]!;
    if (b.kind === 'table') {
      if (b.offset === off) return { bi, table: true };
      continue;
    }
    const li = lineIndex(b.lines, off, affinity);
    if (li >= 0) return { bi, li };
  }
  return null;
}

/** Index of the line holding `off`, or -1. At a soft-wrapped line's start, backward affinity picks the line before. */
function lineIndex(lines: LineLayout[], off: number, affinity: Affinity): number {
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  if (off < first.start || off >= last.end) return -1;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li]!;
    if (off >= l.start && off < l.end) {
      const before = affinity === 'backward' && off === l.start && li > 0 && isSoftWrap(lines[li - 1]!);
      return before ? li - 1 : li;
    }
  }
  return -1;
}

function isSoftWrap(line: LineLayout): boolean {
  const last = line.runs[line.runs.length - 1];
  return !line.breakAfter && !line.rule && last?.kind !== 'break' && last?.kind !== 'mark';
}

// ---------------------------------------------------------------- x within a line

export function xOfOffset(dl: DocLayout, line: LineLayout, off: number): number {
  for (const run of line.runs) {
    if (off <= run.start) return run.x;
    if (off < run.end) {
      if (run.kind === 'text' && run.text !== undefined) return run.x + prefixWidth(dl, run, off - run.start);
      return run.x;
    }
  }
  const last = line.runs[line.runs.length - 1];
  if (!last) return 0;
  return last.kind === 'mark' || last.kind === 'break' ? last.x : last.x + last.width;
}

function prefixWidth(dl: DocLayout, run: RunLayout, n: number): number {
  const text = run.text!.slice(0, n);
  let w = dl.measurer.measure(text, run.style.font) + (run.style.spacing ?? 0) * n;
  if (run.wordSpacing) for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 32) w += run.wordSpacing;
  return w;
}

/** Offset (from the paragraph start) nearest to x within a line, and whether it is the line's soft-wrapped end. */
function offsetAtX(dl: DocLayout, line: LineLayout, x: number): { off: number; atWrapEnd: boolean } {
  const run = line.runs.find((r) => x < r.x + r.width);
  if (run) return { off: offsetInRun(dl, run, x), atWrapEnd: false };
  return offsetPastLine(line);
}

/** Offset nearest to x, for an x left of the run's right edge. */
function offsetInRun(dl: DocLayout, run: RunLayout, x: number): number {
  if (x < run.x) return run.start;
  if (run.kind === 'text' && run.text !== undefined) return run.start + charBoundaryAt(dl, run, run.text, x);
  if (run.kind === 'mark' || run.kind === 'break') return run.start;
  return x < run.x + run.width / 2 ? run.start : run.end;
}

/** Binary search for the character boundary of a text run nearest to x. */
function charBoundaryAt(dl: DocLayout, run: RunLayout, text: string, x: number): number {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const a = prefixWidth(dl, run, mid);
    const b = prefixWidth(dl, run, mid + 1);
    if (run.x + (a + b) / 2 < x) lo = mid + 1;
    else hi = mid;
  }
  // Never between the halves of a surrogate pair.
  const code = text.charCodeAt(lo);
  if (code >= 0xdc00 && code <= 0xdfff) lo++;
  return lo;
}

/** Offset for an x past the line's last run: its mark or break, or its end (a soft-wrapped end). */
function offsetPastLine(line: LineLayout): { off: number; atWrapEnd: boolean } {
  const last = line.runs[line.runs.length - 1];
  if (last && (last.kind === 'mark' || last.kind === 'break')) return { off: last.start, atWrapEnd: false };
  if (line.breakAfter || line.rule) return { off: Math.max(line.start, line.end - 1), atWrapEnd: false };
  return { off: line.end, atWrapEnd: true };
}

// ---------------------------------------------------------------- queries

/** The caret of position `pos` in a story; `page` picks among several (a header on every page). */
export function caretRect(dl: DocLayout, story: string, pos: number, options: { page?: number; affinity?: Affinity } = {}): CaretRect | null {
  const entry = entryAt(dl, story, pos);
  if (!entry) return null;
  const layout = entry.layout!;
  const off = pos - entry.start;
  const at = lineOf(layout, off, options.affinity ?? 'forward');
  if (!at) return null;
  const placed = placedBlock(dl, story, entry, at.bi);
  if ('table' in at) {
    const p = pick(placed, 0, options.page);
    if (!p) return null;
    const b = layout.blocks[at.bi] as Extract<ParagraphLayout['blocks'][number], { kind: 'table' }>;
    return { page: p.page, x: p.x + b.table.x - 2, y: p.y, height: b.table.rows[0]?.height ?? 14 };
  }
  const p = pick(placed, at.li, options.page);
  if (!p) return null;
  const lines = (layout.blocks[at.bi] as Extract<ParagraphLayout['blocks'][number], { kind: 'lines' }>).lines;
  let y = p.y;
  for (let i = p.from; i < at.li; i++) y += lines[i]!.height;
  const line = lines[at.li]!;
  const x = p.x + line.x + xOfOffset(dl, line, off);
  return { page: p.page, x, y, height: line.height };
}

function pick(placed: Placed[], index: number, page: number | undefined): Placed | undefined {
  const holding = placed.filter((p) => index >= p.from && index < p.to);
  return holding.find((p) => p.page === page) ?? holding[0];
}

/** Start and end positions of the visual line holding `pos` (for Home and End). */
export function lineBounds(dl: DocLayout, story: string, pos: number, affinity: Affinity = 'forward'): { start: number; end: number } | null {
  const entry = entryAt(dl, story, pos);
  if (!entry) return null;
  const at = lineOf(entry.layout!, pos - entry.start, affinity);
  if (!at || 'table' in at) return { start: pos, end: pos };
  const line = (entry.layout!.blocks[at.bi] as Extract<ParagraphLayout['blocks'][number], { kind: 'lines' }>).lines[at.li]!;
  const story_ = dl.doc.stories.get(story)!;
  let end = entry.start + line.end;
  const lastChar = story_.charAt(end - 1);
  if (lastChar === PARA || lastChar === LINE_BREAK || line.breakAfter) end--;
  return { start: entry.start + line.start, end };
}

/** The position under a point of a page, or null when the page has nothing there. */
export function hitTest(dl: DocLayout, pageIndex: number, x: number, y: number): HitResult | null {
  const page = dl.pages[pageIndex];
  if (!page) return null;
  const top = page.columns[0]?.y ?? 0;
  const bottom = (page.columns[0]?.y ?? 0) + (page.columns[0]?.height ?? 0);
  let area: PageArea | undefined;
  if (page.header && y < top) area = page.header;
  else if (page.footer && y > bottom && (!page.footnotes || y >= page.footer.y - 6)) area = page.footer;
  else if (page.footnotes && y >= page.footnotes.y && page.footnotes.items.length) area = page.footnotes;
  else {
    // The column nearest to x that has content.
    const cols = page.columns.filter((c) => c.items.length);
    area = cols.reduce<PageArea | undefined>((best, c) => {
      const bd = best ? gap(x, best.x, best.width) : Infinity;
      return gap(x, c.x, c.width) < bd ? c : best;
    }, undefined);
  }
  if (!area || !area.items.length) return null;
  const item = nearestItem(dl, area.items, y);
  return item ? hitItem(dl, item, x, y) : null;
}

/** Distance from `v` to the span [start, start + size]; 0 inside it. */
function gap(v: number, start: number, size: number): number {
  if (v < start) return start - v;
  if (v > start + size) return v - start - size;
  return 0;
}

function itemHeight(item: PlacedItem): number {
  const layout = item.entry.layout;
  const b = layout?.blocks[item.block];
  if (!b) return 0;
  if (b.kind === 'lines') {
    let h = 0;
    for (let i = item.from; i < item.to; i++) h += b.lines[i]!.height;
    return h;
  }
  return rowsHeight(b.table, item.from, item.to) + (item.kind === 'rows' ? item.repeat.reduce((n, r) => n + b.table.rows[r]!.height, 0) : 0);
}

function nearestItem(_dl: DocLayout, items: PlacedItem[], y: number): PlacedItem | undefined {
  let best: PlacedItem | undefined;
  let bestD = Infinity;
  for (const it of items) {
    const h = itemHeight(it);
    const d = gap(y, it.y, h);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

function hitItem(dl: DocLayout, item: PlacedItem, x: number, y: number): HitResult | null {
  const layout = item.entry.layout!;
  const b = layout.blocks[item.block]!;
  if (b.kind === 'lines') return hitLines(dl, item.story, item.entry, b.lines, item.from, item.to, item.x, item.y, x, y);
  let ty = item.y;
  const rows: number[] = [];
  if (item.kind === 'rows') rows.push(...item.repeat);
  for (let r = item.from; r < item.to; r++) rows.push(r);
  return hitTable(dl, item.story, item.entry, b.table, rows, item.x, ty, x, y);
}

function hitLines(dl: DocLayout, story: string, entry: ParaEntry, lines: LineLayout[], from: number, to: number, ox: number, oy: number, x: number, y: number): HitResult {
  let ly = oy;
  let li = from;
  for (; li < to - 1; li++) {
    if (y < ly + lines[li]!.height) break;
    ly += lines[li]!.height;
  }
  const line = lines[li]!;
  const hit = offsetAtX(dl, line, x - ox - line.x);
  return { story, pos: entry.start + hit.off, affinity: hit.atWrapEnd ? 'backward' : 'forward' };
}

function hitTable(dl: DocLayout, story: string, entry: ParaEntry, table: TableLayout, rows: number[], ox: number, oy: number, x: number, y: number): HitResult | null {
  const { row, top } = rowAtY(table, rows, oy, y);
  const hit = cellAtX(table, row, x - ox - table.x, top);
  if (!hit) return { story, pos: entry.start + 0, affinity: 'forward' };
  const cell = hit.cell;
  const cx = ox + table.x + cell.x + cell.padding;
  const cy = hit.top + cellContentOffset(table, cell);
  return hitParagraphs(dl, cell.story, cell.paragraphs, cx, cy, x, y);
}

/** The row under y and its top (rows are drawn in this order, repeated headers first); the last row when y is below them all. */
function rowAtY(table: TableLayout, rows: number[], oy: number, y: number): { row: number; top: number } {
  let ry = oy;
  let top = oy;
  for (const r of rows) {
    const h = table.rows[r]!.height;
    top = ry;
    if (y < ry + h) return { row: r, top };
    ry += h;
  }
  return { row: rows[rows.length - 1]!, top };
}

/**
 * The cell under table x `tx` in a row whose top is `rowTop`, merged cells
 * from rows above included, with its box's top; past either side, the row's
 * first or last cell.
 */
function cellAtX(table: TableLayout, row: number, tx: number, rowTop: number): { cell: CellLayout; top: number } | null {
  for (let r = row; r >= 0; r--) {
    const cell = table.rows[r]!.cells.find((c) => r + c.rowSpan > row && tx >= c.x && tx < c.x + c.width);
    if (cell) return { cell, top: rowTop - rowsHeight(table, r, row) };
  }
  const cells = table.rows[row]!.cells;
  const cell = tx < 0 ? cells[0] : cells[cells.length - 1];
  return cell ? { cell, top: rowTop } : null;
}

function hitParagraphs(dl: DocLayout, story: string, paragraphs: CellLayout['paragraphs'], ox: number, oy: number, x: number, y: number): HitResult | null {
  if (!paragraphs.length) return null;
  let pi = 0;
  for (let i = 0; i < paragraphs.length; i++) if (y >= oy + paragraphs[i]!.y) pi = i;
  const p = paragraphs[pi]!;
  let by = oy + p.y;
  for (let bi = 0; bi < p.layout.blocks.length; bi++) {
    const b = p.layout.blocks[bi]!;
    const h = b.kind === 'lines' ? b.lines.reduce((n, l) => n + l.height, 0) : rowsHeight(b.table, 0, b.table.rows.length);
    if (y < by + h || bi === p.layout.blocks.length - 1) {
      if (b.kind === 'lines') return hitLines(dl, story, p.entry, b.lines, 0, b.lines.length, ox, by, x, y);
      return hitTable(dl, story, p.entry, b.table, b.table.rows.map((_, i) => i), ox, by, x, y);
    }
    by += h;
  }
  return null;
}

/** Rectangles covering [from, to) of a story, one per line part (whole tables when their object is inside). */
export function selectionRects(dl: DocLayout, story: string, from: number, to: number): SelectionRect[] {
  const out: SelectionRect[] = [];
  const flow = dl.flow(story);
  if (!flow || from >= to) return out;
  for (let ei = flow.indexAt(from); ei < flow.entries.length; ei++) {
    const entry = flow.entries[ei]!;
    if (entry.start >= to) break;
    const layout = entry.layout;
    if (!layout) continue;
    layout.blocks.forEach((b, bi) => {
      const placed = placedBlock(dl, story, entry, bi);
      if (b.kind === 'table') {
        const off = entry.start + b.offset;
        if (off < from || off >= to) return;
        for (const p of placed) out.push({ page: p.page, x: p.x + b.table.x, y: p.y, width: b.table.width, height: rowsHeight(b.table, p.from, p.to) });
        return;
      }
      b.lines.forEach((line, li) => {
        const ls = entry.start + line.start;
        const le = entry.start + line.end;
        if (le <= from || ls >= to) return;
        const p = pick(placed, li, undefined);
        if (!p) return;
        let y = p.y;
        for (let i = p.from; i < li; i++) y += b.lines[i]!.height;
        const x1 = from > ls ? xOfOffset(dl, line, from - entry.start) : 0;
        // A selection running past the line's end shows a little past it, as for the paragraph mark.
        const x2 = to < le ? xOfOffset(dl, line, to - entry.start) : Math.max(line.width, xOfOffset(dl, line, line.end)) + 4;
        out.push({ page: p.page, x: p.x + line.x + x1, y, width: Math.max(1, x2 - x1), height: line.height });
      });
    });
  }
  return out;
}

/** The right edge of a table column on a page, for dragging it wider or narrower. */
export interface ColumnEdge {
  tableId: string;
  col: number;
  x: number;
  y: number;
  height: number;
}

/** Column edges of the body tables placed on a page (tables inside cells are left out). */
export function tableColumnEdges(dl: DocLayout, pageIndex: number): ColumnEdge[] {
  const page = dl.pages[pageIndex];
  if (!page) return [];
  const out: ColumnEdge[] = [];
  for (const area of page.columns) {
    for (const item of area.items) {
      const b = item.entry.layout?.blocks[item.block];
      if (item.kind !== 'rows' || b?.kind !== 'table') continue;
      const t = b.table;
      const height = itemHeight(item);
      for (let c = 0; c < t.colX.length; c++) out.push({ tableId: t.id, col: c, x: item.x + t.x + t.colX[c]! + t.colWidths[c]!, y: item.y, height });
    }
  }
  return out;
}
