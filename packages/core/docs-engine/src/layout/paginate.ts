/**
 * Flows the body's laid-out paragraphs into pages: sections and their page
 * setup, headers and footers, columns, footnotes at the foot of the page
 * that references them, and the usual rules for where a page may break
 * (widows and orphans, keep with next, keep lines together, page break
 * before). Table rows never split; header rows repeat on every page.
 */

import { BODY, type HeaderVariant, type SectionProps } from '../model/objects';
import type { DocLayout } from './document-layout';
import type { StoryBlockLayout } from './table';
import type { LineLayout, PageArea, PageLayout, ParaEntry, ParagraphLayout, PlacedItem, TableLayout } from './types';

const HEADER_GAP = 6;
const FOOTNOTE_SEPARATOR = 12;
const FOOTNOTE_GAP = 2;
const EPS = 0.01;

interface Cursor {
  page: PageLayout;
  column: number;
  /** Next free y on the page, points. */
  y: number;
  bottom: number;
  footnotes: { id: string; height: number }[];
  /** Nothing placed in this column yet. */
  empty: boolean;
}

type Section = ReturnType<DocLayout['sections']>[number];

export function paginate(dl: DocLayout): PageLayout[] {
  return new Paginator(dl).run();
}

const contentWidth = (s: SectionProps) => Math.max(36, s.pageWidth - s.marginLeft - s.marginRight);

function columnCount(s: SectionProps): number {
  return Math.max(1, s.columns ?? 1);
}

function columnWidth(s: SectionProps): number {
  const n = columnCount(s);
  return (contentWidth(s) - (s.columnGap ?? 36) * (n - 1)) / n;
}

/** Which header and footer a page shows: the title page's, an even page's, or the default. */
function headerVariant(s: SectionProps, first: boolean, number: number): HeaderVariant {
  if (first && s.titlePage) return 'first';
  if (s.evenAndOdd && number % 2 === 0) return 'even';
  return 'default';
}

/** Height of a paragraph's first line (or first table row), what keep-with-next must bring along. */
function firstLineHeight(layout: ParagraphLayout): number {
  const first = layout.blocks[0];
  if (!first) return 0;
  if (first.kind === 'lines') return first.lines[0]?.height ?? 0;
  return first.table.rows[0]?.height ?? 0;
}

/** Header rows to repeat above row `ri` when a table runs onto a new page. */
function headerRepeat(table: TableLayout, ri: number): number[] {
  return Array.from({ length: Math.min(table.headerRows, ri) }, (_, i) => i);
}

/**
 * One pagination pass. Its state is the section being filled and a cursor
 * (page, column, next free y, the footnotes the page must make room for);
 * each method handles one concern of moving that cursor through the body.
 */
class Paginator {
  private readonly pages: PageLayout[] = [];
  private readonly pageless: boolean;
  private readonly sections: Section[];
  private readonly sectionIds: string[];
  /** Layouts at the width of the section they are placed in, laid out once per pass. */
  private readonly layouts = new Map<ParaEntry, ParagraphLayout>();
  /** Index of the section being filled. */
  private si = 0;
  private pageInSection = 0;
  private cursor!: Cursor;

  constructor(private readonly dl: DocLayout) {
    this.pageless = !!dl.doc.props.pageless;
    this.sections = dl.sections();
    this.sectionIds = this.sections.map((s) => s.id);
  }

  run(): PageLayout[] {
    const flow = this.dl.flow(BODY)!;
    this.dl.placements.clear();
    this.newPage();
    const entries = flow.entries;
    for (let ei = 0; ei < entries.length; ei++) this.placeEntry(entries, ei);
    this.finishPage(this.cursor);
    if (this.pageless) this.fitPagelessPage();
    return this.pages;
  }

  // ---------------------------------------------------------------- paragraphs

  private layoutOf(e: ParaEntry): ParagraphLayout {
    let l = this.layouts.get(e);
    if (!l) {
      l = this.dl.layoutEntry(BODY, e, columnWidth(this.sections[this.si]!.props));
      this.layouts.set(e, l);
    }
    return l;
  }

  private placeEntry(entries: ParaEntry[], ei: number): void {
    const entry = entries[ei]!;
    const layout = this.layoutOf(entry);
    const props = layout.props;

    if (props.pageBreakBefore && !this.pageless && !this.cursor.page.columns.every((c) => c.items.length === 0)) this.nextPage();
    if (props.keepNext && !this.pageless && !this.cursor.empty) this.keepWithNext(entries, ei, layout);
    if (!this.cursor.empty) this.cursor.y += layout.spaceBefore;

    layout.blocks.forEach((block, bi) => {
      if (block.kind === 'lines') this.placeLines(entry, bi, block.lines, layout);
      else this.placeRows(entry, bi, block.table);
    });

    this.cursor.y += layout.spaceAfter;
  }

  /**
   * Keep with next: this paragraph (and a chain of them) moves to the next
   * page with the start of the following one. Called only when the column
   * already holds something, so the paragraph's space before counts.
   */
  private keepWithNext(entries: ParaEntry[], ei: number, layout: ParagraphLayout): void {
    const room = this.cursor.bottom - this.area().y;
    let need = layout.spaceBefore + layout.height + layout.spaceAfter;
    for (let k = ei + 1; k < entries.length && need < room; k++) {
      const next = this.layoutOf(entries[k]!);
      if (!next.props.keepNext) {
        need += next.spaceBefore + firstLineHeight(next);
        break;
      }
      need += next.spaceBefore + next.height + next.spaceAfter;
    }
    if (need > this.space() + EPS && need <= room) this.advance();
  }

  // ---------------------------------------------------------------- lines

  private placeLines(entry: ParaEntry, bi: number, lines: LineLayout[], layout: ParagraphLayout): void {
    let li = 0;
    while (li < lines.length) {
      const k = this.linesToPlace(lines, li, layout);
      if (k === 0) {
        this.advance();
        continue;
      }
      this.registerLines(entry, bi, lines, li, k);
      li += k;
      this.afterLines(lines[li - 1]!, li < lines.length);
    }
  }

  /** How many lines from `li` go in this column; 0 means move on first. */
  private linesToPlace(lines: LineLayout[], li: number, layout: ParagraphLayout): number {
    const fit = this.fitLines(lines, li);
    const remaining = lines.length - li;
    const k = !fit.breaks && fit.count < remaining && !this.pageless ? this.keepRules(layout, li, remaining, fit.count) : fit.count;
    // Taller than a page: place a line anyway.
    if (k === 0 && this.cursor.empty) return 1;
    return k;
  }

  /** How many lines fit (stopping after a line that ends in a break). */
  private fitLines(lines: LineLayout[], li: number): { count: number; breaks: boolean } {
    const space = this.space();
    let k = 0;
    let h = 0;
    let fn = 0;
    while (li + k < lines.length) {
      const line = lines[li + k]!;
      const fh = this.footnoteHeight(line.footnotes);
      if (!this.pageless && h + line.height + fn + fh > space + EPS) break;
      h += line.height;
      fn += fh;
      k++;
      if (line.breakAfter) return { count: k, breaks: true };
    }
    return { count: k, breaks: false };
  }

  /** Widow and orphan control and keep-lines-together, for a paragraph that does not fit: may hold lines back. */
  private keepRules(layout: ParagraphLayout, li: number, remaining: number, fits: number): number {
    const props = layout.props;
    let k = fits;
    const widow = props.widowControl !== false && remaining >= 2;
    if (widow && remaining - k === 1 && k > 1) k--;
    if (widow && li === 0 && k === 1) k = 0;
    if (props.keepLines && li === 0 && layout.height <= this.cursor.bottom - this.area().y) k = 0;
    return k;
  }

  private registerLines(entry: ParaEntry, bi: number, lines: LineLayout[], li: number, k: number): void {
    const area = this.area();
    let y = this.cursor.y;
    for (let n = 0; n < k; n++) y += lines[li + n]!.height;
    this.register(this.cursor.page, area, { kind: 'lines', story: BODY, entry, block: bi, from: li, to: li + k, x: area.x, y: this.cursor.y, width: area.width });
    for (let n = 0; n < k; n++) this.addFootnotes(lines[li + n]!.footnotes);
    this.cursor.y = y;
    this.cursor.empty = false;
  }

  /** After placing lines up to `last`: follow its break, or move on when the paragraph continues. */
  private afterLines(last: LineLayout, more: boolean): void {
    switch (last.breakAfter) {
      case 'section':
        this.startSection();
        return;
      case 'page':
        if (!this.pageless) this.nextPage();
        return;
      case 'column':
        if (!this.pageless) this.advance();
        return;
      default:
        // Only a soft overflow moves on; a break already did (or is ignored when pageless).
        if (more) this.advance();
    }
  }

  /** A section break was placed: the next section starts on a new (even or odd) page unless it is continuous. */
  private startSection(): void {
    this.si = Math.min(this.si + 1, this.sections.length - 1);
    this.pageInSection = 0;
    const start = this.sections[this.si]!.start;
    if (start === 'continuous' || this.pageless) return;
    this.nextPage();
    const parity = this.cursor.page.number % 2;
    if ((start === 'evenPage' && parity === 1) || (start === 'oddPage' && parity === 0)) this.nextPage();
  }

  // ---------------------------------------------------------------- tables

  private placeRows(entry: ParaEntry, bi: number, table: TableLayout): void {
    let ri = 0;
    let repeat: number[] = [];
    while (ri < table.rows.length) {
      const fit = this.fitRows(table, ri, repeat);
      if (fit.count === 0 && !this.cursor.empty) {
        this.advance();
        repeat = headerRepeat(table, ri);
        continue;
      }
      // Taller than a page: place a row anyway.
      const k = Math.max(1, fit.count);
      const area = this.area();
      this.register(this.cursor.page, area, { kind: 'rows', story: BODY, entry, block: bi, repeat, from: ri, to: ri + k, x: area.x, y: this.cursor.y, width: area.width });
      // A forced row is not in fit.height (only the repeated header rows are).
      this.cursor.y += fit.count ? fit.height : fit.height + table.rows[ri]!.height;
      this.cursor.empty = false;
      ri += k;
      if (ri < table.rows.length) {
        this.advance();
        repeat = headerRepeat(table, ri);
      }
    }
  }

  /** How many rows from `ri` fit under the repeated header rows, and their height with those rows. */
  private fitRows(table: TableLayout, ri: number, repeat: number[]): { count: number; height: number } {
    const space = this.space();
    let h = repeat.reduce((n, r) => n + table.rows[r]!.height, 0);
    let k = 0;
    while (ri + k < table.rows.length) {
      const rh = table.rows[ri + k]!.height;
      if (!this.pageless && h + rh > space + EPS) break;
      h += rh;
      k++;
    }
    return { count: k, height: h };
  }

  // ---------------------------------------------------------------- pages

  private register(page: PageLayout, area: PageArea, item: PlacedItem): void {
    area.items.push(item);
    const list = this.dl.placements.get(item.entry);
    if (list) list.push({ page: page.index, area, item });
    else this.dl.placements.set(item.entry, [{ page: page.index, area, item }]);
  }

  /** Places a story laid out flat (header, footer, footnote) into an area. */
  private placeFlat(page: PageLayout, area: PageArea, story: string, layout: StoryBlockLayout, top: number): void {
    for (const p of layout.paragraphs) {
      let y = top + p.y;
      p.layout.blocks.forEach((b, bi) => {
        if (b.kind === 'lines') {
          this.register(page, area, { kind: 'lines', story, entry: p.entry, block: bi, from: 0, to: b.lines.length, x: area.x, y, width: area.width });
          for (const l of b.lines) y += l.height;
        } else {
          this.register(page, area, { kind: 'rows', story, entry: p.entry, block: bi, repeat: [], from: 0, to: b.table.rows.length, x: area.x, y, width: area.width });
          for (const r of b.table.rows) y += r.height;
        }
      });
    }
  }

  private newPage(): void {
    const sec = this.sections[this.si]!;
    const s = sec.props;
    const prev = this.pages[this.pages.length - 1];
    const first = this.pageInSection === 0;
    const number = first && s.pageNumberStart !== undefined ? s.pageNumberStart : (prev?.number ?? 0) + 1;
    const height = this.pageless ? Number.POSITIVE_INFINITY : s.pageHeight;
    const page: PageLayout = {
      index: this.pages.length,
      number,
      label: this.dl.pageLabel(number, s),
      sectionId: sec.id,
      section: s,
      width: s.pageWidth,
      height,
      columns: [],
    };
    let top = s.marginTop;
    let bottom = height - s.marginBottom;
    if (!this.pageless) {
      const variant = headerVariant(s, first, number);
      top = this.placeHeader(page, variant, top);
      bottom = this.placeFooter(page, variant, bottom);
    }
    const colW = columnWidth(s);
    for (let c = 0; c < columnCount(s); c++) {
      page.columns.push({ items: [], x: s.marginLeft + c * (colW + (s.columnGap ?? 36)), y: top, width: colW, height: bottom - top });
    }
    this.pages.push(page);
    this.pageInSection++;
    this.cursor = { page, column: 0, y: top, bottom, footnotes: [], empty: true };
  }

  /** Places the page's header, if the section has one; returns where the body may start. */
  private placeHeader(page: PageLayout, variant: HeaderVariant, top: number): number {
    const header = this.dl.headerStory(this.sectionIds, this.si, 'header', variant);
    if (!header) return top;
    const s = page.section;
    const cw = contentWidth(s);
    const layout = this.dl.layoutStory(header, cw);
    const area: PageArea = { items: [], story: header, x: s.marginLeft, y: s.headerMargin, width: cw, height: layout.height };
    this.placeFlat(page, area, header, layout, s.headerMargin);
    page.header = area;
    return Math.max(top, s.headerMargin + layout.height + HEADER_GAP);
  }

  /** Places the page's footer, if the section has one; returns where the body must end. */
  private placeFooter(page: PageLayout, variant: HeaderVariant, bottom: number): number {
    const footer = this.dl.headerStory(this.sectionIds, this.si, 'footer', variant);
    if (!footer) return bottom;
    const s = page.section;
    const cw = contentWidth(s);
    const layout = this.dl.layoutStory(footer, cw);
    const y = page.height - s.footerMargin - layout.height;
    const area: PageArea = { items: [], story: footer, x: s.marginLeft, y, width: cw, height: layout.height };
    this.placeFlat(page, area, footer, layout, y);
    page.footer = area;
    return Math.min(bottom, y - HEADER_GAP);
  }

  private finishPage(c: Cursor): void {
    if (!c.footnotes.length) return;
    const page = c.page;
    const s = page.section;
    const cw = contentWidth(s);
    let total = FOOTNOTE_SEPARATOR;
    for (const f of c.footnotes) total += f.height + FOOTNOTE_GAP;
    // Above the footer (or bottom margin); after the text when there are no pages.
    const y = this.pageless ? c.y : c.bottom - total;
    if (this.pageless) c.y += total;
    const area: PageArea = { items: [], x: s.marginLeft, y, width: cw, height: total };
    let fy = y + FOOTNOTE_SEPARATOR;
    for (const f of c.footnotes) {
      const story = `fn:${f.id}`;
      this.placeFlat(page, area, story, this.dl.layoutStory(story, cw), fy);
      fy += f.height + FOOTNOTE_GAP;
    }
    page.footnotes = area;
  }

  /** Ends the page and starts the next one. */
  private nextPage(): void {
    this.finishPage(this.cursor);
    this.newPage();
  }

  /** Next column, or a new page when this was the last one. */
  private advance(): void {
    const cursor = this.cursor;
    if (cursor.column + 1 < columnCount(cursor.page.section)) {
      cursor.column++;
      cursor.y = cursor.page.columns[cursor.column]!.y;
      cursor.empty = true;
      return;
    }
    this.nextPage();
  }

  /** The one page of a pageless document ends where its text does. */
  private fitPagelessPage(): void {
    const page = this.pages[0]!;
    page.height = this.cursor.y + page.section.marginBottom;
    for (const c of page.columns) c.height = this.cursor.y - c.y;
  }

  // ---------------------------------------------------------------- footnotes and space

  /** Room footnotes referenced by a line would take, the separator included when they are the page's first. */
  private footnoteHeight(ids: string[] | undefined): number {
    if (!ids?.length) return 0;
    const cw = contentWidth(this.cursor.page.section);
    let h = this.cursor.footnotes.length ? 0 : FOOTNOTE_SEPARATOR;
    for (const id of ids) h += this.dl.layoutStory(`fn:${id}`, cw).height + FOOTNOTE_GAP;
    return h;
  }

  private reservedFootnotes(): number {
    if (!this.cursor.footnotes.length) return 0;
    let h = FOOTNOTE_SEPARATOR;
    for (const f of this.cursor.footnotes) h += f.height + FOOTNOTE_GAP;
    return h;
  }

  private addFootnotes(ids: string[] | undefined): void {
    if (!ids) return;
    const cw = contentWidth(this.cursor.page.section);
    for (const id of ids) this.cursor.footnotes.push({ id, height: this.dl.layoutStory(`fn:${id}`, cw).height });
  }

  /** Free height left in the column, after the footnotes it already holds. */
  private space(): number {
    return this.cursor.bottom - this.cursor.y - this.reservedFootnotes();
  }

  private area(): PageArea {
    return this.cursor.page.columns[this.cursor.column]!;
  }
}
