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
import type { LineLayout, PageArea, PageLayout, ParaEntry, ParagraphLayout, PlacedItem } from './types';

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

export function paginate(dl: DocLayout): PageLayout[] {
  const doc = dl.doc;
  const pageless = !!doc.props.pageless;
  const sections = dl.sections();
  const sectionIds = sections.map((s) => s.id);
  const flow = dl.flow(BODY)!;
  dl.placements.clear();

  const pages: PageLayout[] = [];
  let si = 0;
  let pageInSection = 0;
  let cursor!: Cursor;

  const contentWidth = (s: SectionProps) => Math.max(36, s.pageWidth - s.marginLeft - s.marginRight);
  const columnWidth = (s: SectionProps) => {
    const n = Math.max(1, s.columns ?? 1);
    return (contentWidth(s) - (s.columnGap ?? 36) * (n - 1)) / n;
  };

  const register = (page: PageLayout, area: PageArea, item: PlacedItem) => {
    area.items.push(item);
    const list = dl.placements.get(item.entry);
    if (list) list.push({ page: page.index, area, item });
    else dl.placements.set(item.entry, [{ page: page.index, area, item }]);
  };

  /** Places a story laid out flat (header, footer, footnote) into an area. */
  const placeFlat = (page: PageLayout, area: PageArea, story: string, layout: StoryBlockLayout, top: number) => {
    for (const p of layout.paragraphs) {
      let y = top + p.y;
      p.layout.blocks.forEach((b, bi) => {
        if (b.kind === 'lines') {
          register(page, area, { kind: 'lines', story, entry: p.entry, block: bi, from: 0, to: b.lines.length, x: area.x, y, width: area.width });
          for (const l of b.lines) y += l.height;
        } else {
          register(page, area, { kind: 'rows', story, entry: p.entry, block: bi, repeat: [], from: 0, to: b.table.rows.length, x: area.x, y, width: area.width });
          for (const r of b.table.rows) y += r.height;
        }
      });
    }
  };

  const newPage = (): void => {
    const sec = sections[si]!;
    const s = sec.props;
    const prev = pages[pages.length - 1];
    const first = pageInSection === 0;
    const number = first && s.pageNumberStart !== undefined ? s.pageNumberStart : (prev?.number ?? 0) + 1;
    const width = s.pageWidth;
    const height = pageless ? Number.POSITIVE_INFINITY : s.pageHeight;
    const cw = contentWidth(s);
    const page: PageLayout = {
      index: pages.length,
      number,
      label: dl.pageLabel(number, s),
      sectionId: sec.id,
      section: s,
      width,
      height,
      columns: [],
    };
    let top = s.marginTop;
    let bottom = height - s.marginBottom;
    if (!pageless) {
      const variant: HeaderVariant = first && s.titlePage ? 'first' : s.evenAndOdd && number % 2 === 0 ? 'even' : 'default';
      const header = dl.headerStory(sectionIds, si, 'header', variant);
      if (header) {
        const layout = dl.layoutStory(header, cw);
        const area: PageArea = { items: [], story: header, x: s.marginLeft, y: s.headerMargin, width: cw, height: layout.height };
        placeFlat(page, area, header, layout, s.headerMargin);
        page.header = area;
        top = Math.max(top, s.headerMargin + layout.height + HEADER_GAP);
      }
      const footer = dl.headerStory(sectionIds, si, 'footer', variant);
      if (footer) {
        const layout = dl.layoutStory(footer, cw);
        const y = height - s.footerMargin - layout.height;
        const area: PageArea = { items: [], story: footer, x: s.marginLeft, y, width: cw, height: layout.height };
        placeFlat(page, area, footer, layout, y);
        page.footer = area;
        bottom = Math.min(bottom, y - HEADER_GAP);
      }
    }
    const n = Math.max(1, s.columns ?? 1);
    const colW = columnWidth(s);
    for (let c = 0; c < n; c++) {
      page.columns.push({ items: [], x: s.marginLeft + c * (colW + (s.columnGap ?? 36)), y: top, width: colW, height: bottom - top });
    }
    pages.push(page);
    pageInSection++;
    cursor = { page, column: 0, y: top, bottom, footnotes: [], empty: true };
  };

  const finishPage = (c: Cursor) => {
    if (!c.footnotes.length) return;
    const page = c.page;
    const s = page.section;
    const cw = contentWidth(s);
    let total = FOOTNOTE_SEPARATOR;
    for (const f of c.footnotes) total += f.height + FOOTNOTE_GAP;
    // Above the footer (or bottom margin); after the text when there are no pages.
    const y = pageless ? c.y : c.bottom - total;
    if (pageless) c.y += total;
    const area: PageArea = { items: [], x: s.marginLeft, y, width: cw, height: total };
    let fy = y + FOOTNOTE_SEPARATOR;
    for (const f of c.footnotes) {
      const story = `fn:${f.id}`;
      placeFlat(page, area, story, dl.layoutStory(story, cw), fy);
      fy += f.height + FOOTNOTE_GAP;
    }
    page.footnotes = area;
  };

  /** Next column, or a new page when this was the last one. */
  const advance = (): void => {
    const s = cursor.page.section;
    if (cursor.column + 1 < Math.max(1, s.columns ?? 1)) {
      cursor.column++;
      const area = cursor.page.columns[cursor.column]!;
      cursor.y = area.y;
      cursor.empty = true;
      return;
    }
    finishPage(cursor);
    newPage();
  };

  const footnoteHeight = (ids: string[] | undefined): number => {
    if (!ids?.length) return 0;
    const cw = contentWidth(cursor.page.section);
    let h = cursor.footnotes.length ? 0 : FOOTNOTE_SEPARATOR;
    for (const id of ids) h += dl.layoutStory(`fn:${id}`, cw).height + FOOTNOTE_GAP;
    return h;
  };
  const reservedFootnotes = (): number => {
    if (!cursor.footnotes.length) return 0;
    let h = FOOTNOTE_SEPARATOR;
    for (const f of cursor.footnotes) h += f.height + FOOTNOTE_GAP;
    return h;
  };
  const addFootnotes = (ids: string[] | undefined) => {
    if (!ids) return;
    const cw = contentWidth(cursor.page.section);
    for (const id of ids) cursor.footnotes.push({ id, height: dl.layoutStory(`fn:${id}`, cw).height });
  };
  const space = () => cursor.bottom - cursor.y - reservedFootnotes();
  const area = () => cursor.page.columns[cursor.column]!;

  newPage();
  const entries = flow.entries;
  const layouts = new Map<ParaEntry, ParagraphLayout>();
  const layoutOf = (e: ParaEntry): ParagraphLayout => {
    let l = layouts.get(e);
    if (!l) {
      l = dl.layoutEntry(BODY, e, columnWidth(sections[si]!.props));
      layouts.set(e, l);
    }
    return l;
  };

  for (let ei = 0; ei < entries.length; ei++) {
    const entry = entries[ei]!;
    const layout = layoutOf(entry);
    const props = layout.props;

    if (props.pageBreakBefore && !pageless && !cursor.page.columns.every((c) => c.items.length === 0)) {
      finishPage(cursor);
      newPage();
    }

    // Keep with next: this paragraph (and a chain of them) moves to the next page with the start of the following one.
    if (props.keepNext && !pageless && !cursor.empty) {
      let need = (cursor.empty ? 0 : layout.spaceBefore) + layout.height + layout.spaceAfter;
      let k = ei + 1;
      while (k < entries.length && need < cursor.bottom - area().y) {
        const next = layoutOf(entries[k]!);
        const firstLine = next.blocks[0]?.kind === 'lines' ? next.blocks[0].lines[0]?.height ?? 0 : next.blocks[0]?.kind === 'table' ? next.blocks[0].table.rows[0]?.height ?? 0 : 0;
        if (!next.props.keepNext) {
          need += next.spaceBefore + firstLine;
          break;
        }
        need += next.spaceBefore + next.height + next.spaceAfter;
        k++;
      }
      if (need > space() + EPS && need <= cursor.bottom - area().y) advance();
    }

    if (!cursor.empty) cursor.y += layout.spaceBefore;

    layout.blocks.forEach((block, bi) => {
      if (block.kind === 'lines') {
        const lines = block.lines;
        let li = 0;
        while (li < lines.length) {
          // How many lines fit (stopping after a line that ends in a break).
          let k = 0;
          let h = 0;
          let fn = 0;
          let breakAt: LineLayout | null = null;
          while (li + k < lines.length) {
            const line = lines[li + k]!;
            const fh = footnoteHeight(line.footnotes);
            if (!pageless && h + line.height + fn + fh > space() + EPS) break;
            h += line.height;
            fn += fh;
            k++;
            if (line.breakAfter) {
              breakAt = line;
              break;
            }
          }
          const remaining = lines.length - li;
          const all = k === remaining || breakAt !== null;
          if (!all && !pageless) {
            const widow = props.widowControl !== false && remaining >= 2;
            if (widow && remaining - k === 1 && k > 1) k--;
            if (widow && li === 0 && k === 1) k = 0;
            if (props.keepLines && li === 0 && layout.height <= cursor.bottom - area().y) k = 0;
          }
          if (k === 0) {
            if (cursor.empty) k = 1; // Taller than a page: place a line anyway.
            else {
              advance();
              continue;
            }
          }
          let y = cursor.y;
          for (let n = 0; n < k; n++) y += lines[li + n]!.height;
          register(cursor.page, area(), { kind: 'lines', story: BODY, entry, block: bi, from: li, to: li + k, x: area().x, y: cursor.y, width: area().width });
          for (let n = 0; n < k; n++) addFootnotes(lines[li + n]!.footnotes);
          cursor.y = y;
          cursor.empty = false;
          li += k;
          const last = lines[li - 1]!;
          if (last.breakAfter === 'section') {
            si = Math.min(si + 1, sections.length - 1);
            pageInSection = 0;
            const start = sections[si]!.start;
            if (start !== 'continuous' && !pageless) {
              finishPage(cursor);
              newPage();
              if ((start === 'evenPage' && cursor.page.number % 2 === 1) || (start === 'oddPage' && cursor.page.number % 2 === 0)) {
                finishPage(cursor);
                newPage();
              }
            }
          } else if (last.breakAfter === 'page' && !pageless) {
            finishPage(cursor);
            newPage();
          } else if (last.breakAfter === 'column' && !pageless) {
            advance();
          } else if (li < lines.length && !last.breakAfter) {
            // Only a soft overflow moves on; a break already did (or is ignored when pageless).
            advance();
          }
        }
      } else {
        const table = block.table;
        let ri = 0;
        let repeat: number[] = [];
        while (ri < table.rows.length) {
          let h = repeat.reduce((n, r) => n + table.rows[r]!.height, 0);
          let k = 0;
          while (ri + k < table.rows.length) {
            const rh = table.rows[ri + k]!.height;
            if (!pageless && h + rh > space() + EPS) break;
            h += rh;
            k++;
          }
          if (k === 0) {
            if (cursor.empty) k = 1;
            else {
              advance();
              repeat = ri > 0 ? Array.from({ length: Math.min(table.headerRows, ri) }, (_, i) => i) : [];
              continue;
            }
          }
          register(cursor.page, area(), { kind: 'rows', story: BODY, entry, block: bi, repeat, from: ri, to: ri + k, x: area().x, y: cursor.y, width: area().width });
          cursor.y += h;
          cursor.empty = false;
          ri += k;
          if (ri < table.rows.length) {
            advance();
            repeat = Array.from({ length: Math.min(table.headerRows, ri) }, (_, i) => i);
          }
        }
      }
    });

    cursor.y += layout.spaceAfter;
  }
  finishPage(cursor!);

  if (pageless) {
    const page = pages[0]!;
    page.height = cursor!.y + page.section.marginBottom;
    for (const c of page.columns) c.height = cursor!.y - c.y;
  }
  return pages;
}
