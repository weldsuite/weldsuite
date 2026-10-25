/**
 * PDF export, from scratch: the document is laid out with the built-in
 * standard-font metrics and every page is written from the same display
 * list the editor draws, so the PDF and the screen agree.
 *
 * Latin text uses the standard 14 fonts (nothing embedded). Characters
 * WinAnsi cannot encode use a TrueType font from `options.fonts`, embedded
 * as a subset; without one they show as '?'. Every character lands where
 * the layout put it: the standard fonts' /Widths are the layout's widths,
 * and runs in an embedded font are positioned glyph by glyph.
 */

import { OBJECT } from '../../model/chars';
import type { DocModel } from '../../model/document';
import { BODY } from '../../model/objects';
import { outlineLevel } from '../../model/resolve';
import { DocLayout } from '../../layout/document-layout';
import { pageDisplay, type DisplayItem, type DisplayOptions } from '../../layout/display';
import { caretRect } from '../../layout/geometry';
import { MetricsMeasurer, type FontSpec } from '../../layout/measure';
import type { PageLayout } from '../../layout/types';
import { latin1, hex4 } from './bytes';
import { EmbeddedFont } from './cid-font';
import { ContentStream, parseColor, type Rgb } from './content';
import { dataUrlBytes, readImage, type PdfImage } from './images';
import { PdfWriter, literal, name, num, pdfDate, ref, textString } from './pdf-writer';
import { FIRST_CHAR, LAST_CHAR, roundWidth, standardFont, standardWidths, winAnsiCode, type StandardFontName } from './standard-fonts';
import { parseTrueType } from './truetype';

export interface PdfExportOptions {
  /** Document title (info dictionary, `title` fields). */
  title?: string;
  author?: string;
  /** Language of the text (catalog /Lang) and of `date` fields. */
  locale?: string;
  /** Creation date and what `date` fields show (default: now). */
  date?: Date;
  /** Fetches an image's bytes by its `src` (`data:` URLs are read without it). */
  images?: (src: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  /**
   * A TrueType font for a family, for characters outside WinAnsi. Asked
   * for the run's family first, then for `'fallback'`.
   */
  fonts?: (family: string, bold: boolean, italic: boolean) => Promise<Uint8Array | null>;
}

const PLACEHOLDER: Rgb = [0.91, 0.91, 0.91];
const BLACK: Rgb = [0, 0, 0];
/** Link schemes a PDF may open; anything else (javascript:, file:) is dropped. */
const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

export async function exportPdf(doc: DocModel, options: PdfExportOptions = {}): Promise<Uint8Array> {
  const date = options.date ?? new Date();
  const dl = new DocLayout(doc, { measurer: new MetricsMeasurer() });
  const pages = dl.update();
  const pdf = new PdfWriter();
  const catalog = pdf.alloc();
  const pagesRef = pdf.alloc();
  const resources = pdf.alloc();
  const ex = new Exporter(pdf, dl, options);

  // Every page's object number up front: a link may point at a page not written yet.
  const pageRefs = pages.map(() => pdf.alloc());
  const display: DisplayOptions = { date };
  if (options.title !== undefined) display.title = options.title;
  if (options.locale !== undefined) display.locale = options.locale;
  const dest = (anchorId: string) => anchorDest(dl, pageRefs, anchorId);
  for (const [i, page] of pages.entries()) {
    const n = pageRefs[i]!;
    const content = new ContentStream(page.height);
    const annots = await ex.drawPage(content, page, pageDisplay(dl, page, display), dest);
    const contents = await pdf.stream('', latin1(content.text));
    const annotRefs = annots.map((a) => pdf.add(a));
    const annotsEntry = annotRefs.length ? ` /Annots [${annotRefs.map(ref).join(' ')}]` : '';
    pdf.set(
      n,
      `<< /Type /Page /Parent ${ref(pagesRef)} /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources ${ref(resources)} /Contents ${ref(contents)}${annotsEntry} >>`,
    );
  }
  if (!pageRefs.length) {
    // A PDF needs a page; an empty layout gets one blank page of the document's size.
    const s = doc.props.section;
    const contents = await pdf.stream('', new Uint8Array(0));
    pageRefs.push(pdf.add(`<< /Type /Page /Parent ${ref(pagesRef)} /MediaBox [0 0 ${num(s.pageWidth)} ${num(s.pageHeight)}] /Resources ${ref(resources)} /Contents ${ref(contents)} >>`));
  }

  pdf.set(resources, await ex.resources());
  pdf.set(pagesRef, `<< /Type /Pages /Kids [${pageRefs.map(ref).join(' ')}] /Count ${pageRefs.length} >>`);
  const outlines = writeOutlines(pdf, dl, pages, pageRefs);

  let info = `/Producer (WeldDocs) /Creator (WeldDocs) /CreationDate ${literal(pdfDate(date))} /ModDate ${literal(pdfDate(date))}`;
  if (options.title) info += ` /Title ${textString(options.title)}`;
  if (options.author) info += ` /Author ${textString(options.author)}`;
  const infoRef = pdf.add(`<< ${info} >>`);

  let cat = `/Type /Catalog /Pages ${ref(pagesRef)}`;
  if (outlines) cat += ` /Outlines ${ref(outlines)} /PageMode /UseOutlines`;
  if (options.locale) cat += ` /Lang ${textString(options.locale)}`;
  if (options.title) cat += ' /ViewerPreferences << /DisplayDocTitle true >>';
  pdf.set(catalog, `<< ${cat} >>`);
  return pdf.finish(catalog, infoRef);
}

/** Where an internal link (`#bookmark`) goes: the bookmark's page, scrolled to it; null when it is gone. */
function anchorDest(dl: DocLayout, pageRefs: number[], anchorId: string): string | null {
  const anchor = dl.doc.anchors.get(anchorId);
  if (!anchor) return null;
  const rect = caretRect(dl, anchor.story, anchor.from);
  const page = rect ? dl.pages[rect.page] : undefined;
  if (!rect || !page) return null;
  return `[${ref(pageRefs[rect.page]!)} /XYZ 0 ${num(page.height - rect.y)} null]`;
}

type Shape = { kind: 'circle' | 'square' | 'diamond'; fill: boolean; scale: number };

/** Bullet glyphs outside WinAnsi, drawn as shapes when no embedded font has them. */
const SHAPES: Record<string, Shape> = {
  '●': { kind: 'circle', fill: true, scale: 1 },
  '○': { kind: 'circle', fill: false, scale: 1 },
  '◦': { kind: 'circle', fill: false, scale: 0.7 },
  '■': { kind: 'square', fill: true, scale: 1 },
  '□': { kind: 'square', fill: false, scale: 1 },
  '▪': { kind: 'square', fill: true, scale: 0.7 },
  '◆': { kind: 'diamond', fill: true, scale: 1 },
  '◇': { kind: 'diamond', fill: false, scale: 1 },
  '☐': { kind: 'square', fill: false, scale: 1.3 },
};

/** How one character is drawn. */
type Glyph =
  | { kind: 'std'; code: number }
  | { kind: 'cid'; font: EmbeddedFont; cid: number }
  | { kind: 'shape'; shape: Shape }
  | { kind: 'skip' };

const INVISIBLE = /^[\p{Cc}\p{Cf}]$/u;

/** A link's action: open a safe web address, or go to a bookmark's page. Null for anything else. */
function linkAction(link: string, dest: (anchorId: string) => string | null): string | null {
  if (link.startsWith('#')) {
    const d = dest(link.slice(1));
    return d ? `<< /S /GoTo /D ${d} >>` : null;
  }
  return SAFE_LINK.test(link) ? `<< /S /URI /URI ${literal(uriBytes(link))} >>` : null;
}

type DisplayOf<K extends DisplayItem['kind']> = Extract<DisplayItem, { kind: K }>;
type TextItem = DisplayOf<'text'>;

/** A link annotation being collected: its rectangle in PDF space, target and action. */
interface PageLink {
  rect: [number, number, number, number];
  uri: string;
  action: string;
}

function drawRect(c: ContentStream, item: DisplayOf<'rect'>): void {
  const fill = parseColor(item.fill);
  if (fill) c.fillRect(item.x, item.y, item.width, item.height, fill, item.radius ?? 0);
}

function drawLine(c: ContentStream, item: DisplayOf<'line'>): void {
  const color = parseColor(item.color);
  if (color) c.line(item.x1, item.y1, item.x2, item.y2, item.width, color, item.style);
}

/** Adds a text item's link to `links`; pieces of one link on one line become one annotation. */
function addLink(links: PageLink[], c: ContentStream, item: TextItem, dest: (anchorId: string) => string | null): void {
  const link = item.style.link;
  const action = link ? linkAction(link, dest) : null;
  if (!link || !action) return;
  const rect: [number, number, number, number] = [item.x, c.y(item.baseline + item.descent), item.x + item.width, c.y(item.baseline - item.ascent)];
  const last = links[links.length - 1];
  if (last && last.uri === link && Math.abs(last.rect[1] - rect[1]) < 0.5 && Math.abs(last.rect[2] - rect[0]) < 0.5) {
    last.rect[2] = rect[2];
    last.rect[3] = Math.max(last.rect[3], rect[3]);
  } else links.push({ rect, uri: link, action });
}

/** What a text item's runs share. */
interface TextState {
  size: number;
  spacing: number;
  /** Word spacing (justified lines), applied to standard-font runs. */
  ws: number;
  baseline: number;
}

/** One shown glyph: its code and how far to move after it (TJ units). */
interface RunPart {
  code: string;
  adjust: number;
}

/** Collects glyphs into runs of one font, each shown with one TJ. */
class TextRuns {
  /** Glyphs of the run being collected: what to show and how far to move after each. */
  private run: { font: EmbeddedFont | null; x: number; parts: RunPart[] } | null = null;

  constructor(
    private readonly c: ContentStream,
    private readonly t: TextState,
    /** The standard font's resource name, asked for only when a standard run is shown. */
    private readonly standardResource: () => string,
  ) {}

  add(font: EmbeddedFont | null, x: number, part: RunPart): void {
    if (!this.run || this.run.font !== font) {
      this.flush();
      this.run = { font, x, parts: [] };
    }
    this.run.parts.push(part);
  }

  flush(): void {
    const r = this.run;
    this.run = null;
    if (!r?.parts.length) return;
    const { c, t } = this;
    const res = r.font ? r.font.resource : this.standardResource();
    const shown = (s: string): string => (r.font ? `<${s}>` : literal(s));
    let tj = '';
    let str = '';
    for (const p of r.parts) {
      str += p.code;
      // TJ numbers are thousandths of an em, positive moves left.
      if (Math.abs(p.adjust) > 0.05) {
        tj += `${shown(str)} ${num(p.adjust)} `;
        str = '';
      }
    }
    if (str) tj += shown(str);
    c.op('BT');
    c.op(`/${res} ${num(t.size)} Tf`);
    c.spacing(t.spacing, r.font ? 0 : t.ws);
    c.op(`1 0 0 1 ${num(r.x)} ${num(c.y(t.baseline))} Tm`);
    c.op(`[${tj.trim()}] TJ`);
    c.op('ET');
  }
}

/** A WinAnsi character drawn in the standard font, without waiting for anything; null for the rest. */
function standardGlyph(ch: string): Glyph | null {
  const code = winAnsiCode(ch.codePointAt(0)!);
  return code !== null && !INVISIBLE.test(ch) ? { kind: 'std', code } : null;
}

/** A standard-font glyph that has to advance `target` points. */
function standardPart(code: number, target: number, widths: number[], t: TextState): RunPart {
  const natural = (widths[code - FIRST_CHAR]! / 1000) * t.size + t.spacing + (code === 32 ? t.ws : 0);
  return { code: String.fromCharCode(code), adjust: (-(target - natural) * 1000) / t.size };
}

/** An embedded-font glyph that has to advance `target` points. */
function embeddedPart(font: EmbeddedFont, cid: number, target: number, t: TextState): RunPart {
  const natural = (font.width(cid) / 1000) * t.size + t.spacing;
  return { code: hex4(cid), adjust: (-(target - natural) * 1000) / t.size };
}

class Exporter {
  private readonly standard = new Map<StandardFontName, string>();
  private readonly embedded: EmbeddedFont[] = [];
  /** Parsed fonts by provider key; the same bytes under two keys embed once. */
  private readonly fontKeys = new Map<string, Promise<EmbeddedFont | null>>();
  private readonly fontBytes = new Map<Uint8Array, EmbeddedFont>();
  private readonly images = new Map<string, Promise<string | null>>();
  private readonly imageRefs = new Map<string, number>();

  constructor(
    private readonly pdf: PdfWriter,
    private readonly dl: DocLayout,
    private readonly options: PdfExportOptions,
  ) {}

  // ---------------------------------------------------------------- pages

  /** Draws a page's display list; returns its link annotations (`dest` resolves links to bookmarks). */
  async drawPage(c: ContentStream, page: PageLayout, items: DisplayItem[], dest: (anchorId: string) => string | null = () => null): Promise<string[]> {
    const links: PageLink[] = [];
    const bg = parseColor(page.section.background);
    if (bg) c.fillRect(0, 0, page.width, page.height, bg);
    for (const item of items) {
      switch (item.kind) {
        case 'rect':
          drawRect(c, item);
          break;
        case 'line':
          drawLine(c, item);
          break;
        case 'checkbox':
          c.checkbox(item.x, item.y, item.size, item.checked, parseColor(item.color) ?? BLACK);
          break;
        case 'image':
          await this.drawImage(c, item);
          break;
        case 'text':
          await this.drawText(c, item);
          addLink(links, c, item, dest);
          break;
      }
    }
    return links.map((l) => `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(' ')}] /Border [0 0 0] /A ${l.action} >>`);
  }

  private async drawImage(c: ContentStream, item: DisplayOf<'image'>): Promise<void> {
    const res = await this.image(item.image.src);
    if (res) c.image(res, item.x, item.y, item.width, item.height, item.image.crop);
    else c.fillRect(item.x, item.y, item.width, item.height, PLACEHOLDER);
    const border = item.image.border;
    const bc = parseColor(border?.color);
    if (border && border.width > 0 && bc) c.strokeRect(item.x, item.y, item.width, item.height, bc, border.width);
  }

  private async drawText(c: ContentStream, item: TextItem): Promise<void> {
    const style = item.style;
    const font = style.font;
    const size = font.size;
    const color = parseColor(style.color) ?? BLACK;
    const spacing = style.spacing ?? 0;
    const ws = item.wordSpacing ?? 0;
    const std = standardFont(font);
    const stdWidths = this.widthsOf(std);
    const measurer = this.dl.measurer;
    const t: TextState = { size, spacing, ws, baseline: item.baseline };
    const runs = new TextRuns(c, t, () => this.standardResource(std));

    c.fillColor(color);
    let x = item.x;
    for (const ch of item.text) {
      const target = measurer.measure(ch, font) + spacing + (ch === ' ' ? ws : 0);
      // Most characters are WinAnsi; only the rest may wait for a font to load.
      const glyph: Glyph = standardGlyph(ch) ?? (await this.glyph(ch, font));
      if (glyph.kind === 'std') runs.add(null, x, standardPart(glyph.code, target, stdWidths, t));
      else if (glyph.kind === 'cid') runs.add(glyph.font, x, embeddedPart(glyph.font, glyph.cid, target, t));
      else {
        runs.flush();
        if (glyph.kind === 'shape') this.drawShape(c, glyph.shape, x, target - spacing, item.baseline, size, color);
      }
      x += target;
    }
    runs.flush();

    const thickness = Math.max(0.4, size * 0.05);
    if (style.underline) c.fillRect(item.x, item.baseline + size * 0.1, item.width, thickness, color);
    if (style.strike) c.fillRect(item.x, item.baseline - size * 0.3, item.width, thickness, color);
  }

  private drawShape(c: ContentStream, shape: Shape, x: number, advance: number, baseline: number, size: number, color: Rgb): void {
    const cx = x + advance / 2;
    const cy = baseline - size * 0.32;
    const r = size * 0.17 * shape.scale;
    const lw = Math.max(0.4, size * 0.06);
    if (shape.kind === 'circle') c.circlePath(cx, cy, r);
    else if (shape.kind === 'square') c.rectPath(cx - r, cy - r, 2 * r, 2 * r);
    else c.op(`${num(cx)} ${num(c.y(cy - r * 1.3))} m ${num(cx + r * 1.3)} ${num(c.y(cy))} l ${num(cx)} ${num(c.y(cy + r * 1.3))} l ${num(cx - r * 1.3)} ${num(c.y(cy))} l h`);
    if (shape.fill) {
      c.fillColor(color);
      c.op('f');
    } else {
      c.strokeColor(color);
      c.op(`${num(lw)} w [] 0 d s`);
    }
  }

  // ---------------------------------------------------------------- fonts

  /** Decides how a character is drawn: standard font, embedded font, a shape, '?', or not at all. */
  private async glyph(ch: string, font: FontSpec): Promise<Glyph> {
    if (INVISIBLE.test(ch)) return { kind: 'skip' };
    const cp = ch.codePointAt(0)!;
    const code = winAnsiCode(cp);
    if (code !== null) return { kind: 'std', code };
    for (const [family, bold, italic] of fontCandidates(font)) {
      const embedded = await this.embeddedFont(family, bold, italic);
      const cid = embedded?.cid(cp);
      if (embedded && cid != null) return { kind: 'cid', font: embedded, cid };
    }
    const shape = SHAPES[ch];
    if (shape) return { kind: 'shape', shape };
    return { kind: 'std', code: 63 }; // '?'
  }

  private embeddedFont(family: string, bold: boolean, italic: boolean): Promise<EmbeddedFont | null> {
    const fetch = this.options.fonts;
    if (!fetch) return Promise.resolve(null);
    const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}|${family}`;
    let p = this.fontKeys.get(key);
    if (!p) {
      p = (async () => {
        try {
          const bytes = await fetch(family, bold, italic);
          if (!bytes) return null;
          const known = this.fontBytes.get(bytes);
          if (known) return known;
          const parsed = parseTrueType(bytes);
          if (!parsed) return null;
          const embedded = new EmbeddedFont(parsed, `E${this.embedded.length + 1}`, this.pdf);
          this.embedded.push(embedded);
          this.fontBytes.set(bytes, embedded);
          return embedded;
        } catch {
          return null;
        }
      })();
      this.fontKeys.set(key, p);
    }
    return p;
  }

  private standardResource(font: StandardFontName): string {
    let res = this.standard.get(font);
    if (!res) {
      res = `F${this.standard.size + 1}`;
      this.standard.set(font, res);
    }
    return res;
  }

  private readonly widthCache = new Map<StandardFontName, number[]>();

  private widthsOf(font: StandardFontName): number[] {
    let w = this.widthCache.get(font);
    if (!w) {
      w = standardWidths(font, this.dl.measurer);
      this.widthCache.set(font, w);
    }
    return w;
  }

  // ---------------------------------------------------------------- images

  /** The XObject resource name for an image source, null when it cannot be loaded. */
  private image(src: string): Promise<string | null> {
    let p = this.images.get(src);
    if (!p) {
      p = this.loadImage(src);
      this.images.set(src, p);
    }
    return p;
  }

  private async loadImage(src: string): Promise<string | null> {
    let image: PdfImage | null = null;
    try {
      const bytes = dataUrlBytes(src) ?? (await this.options.images?.(src))?.bytes;
      if (bytes) image = await readImage(bytes);
    } catch {
      image = null;
    }
    if (!image) return null;
    const res = `Im${this.imageRefs.size + 1}`;
    this.imageRefs.set(res, await writeImage(this.pdf, image));
    return res;
  }

  // ---------------------------------------------------------------- resources

  /** Writes the fonts and returns the shared resource dictionary. */
  async resources(): Promise<string> {
    const fonts: string[] = [];
    for (const [font, res] of this.standard) {
      const widths = this.widthsOf(font).map((w) => num(roundWidth(w)));
      const n = this.pdf.add(
        `<< /Type /Font /Subtype /Type1 /BaseFont ${name(font)} /Encoding /WinAnsiEncoding ` +
          `/FirstChar ${FIRST_CHAR} /LastChar ${LAST_CHAR} /Widths [${widths.join(' ')}] >>`,
      );
      fonts.push(`/${res} ${ref(n)}`);
    }
    for (const font of this.embedded) {
      if (font.subset.size <= 1) continue; // loaded but never used
      await font.write(this.pdf);
      fonts.push(`/${font.resource} ${ref(font.n)}`);
    }
    // Fonts that were loaded but never drew a glyph still own a reserved object.
    for (const font of this.embedded) if (font.subset.size <= 1) this.pdf.set(font.n, 'null');
    const xobjects = [...this.imageRefs].map(([res, n]) => `/${res} ${ref(n)}`);
    const xobjectEntry = xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : '';
    return `<< /ProcSet [/PDF /Text /ImageB /ImageC] /Font << ${fonts.join(' ')} >>${xobjectEntry} >>`;
  }
}

/** The fonts to try for a character outside WinAnsi, in order. */
function fontCandidates(font: FontSpec): [string, boolean, boolean][] {
  const out: [string, boolean, boolean][] = [[font.family, font.bold, font.italic], ['fallback', font.bold, font.italic]];
  if (font.bold || font.italic) out.push(['fallback', false, false]);
  return out;
}

async function writeImage(pdf: PdfWriter, image: PdfImage): Promise<number> {
  if (image.kind === 'jpeg') {
    const { info } = image;
    const space = jpegColorSpace(info.components);
    // Adobe's CMYK JPEGs store inverted values.
    const decode = info.components === 4 && info.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    return pdf.stream(
      `/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${space} /BitsPerComponent 8${decode} /Filter /DCTDecode`,
      image.bytes,
      { compress: false },
    );
  }
  const { width, height, colors, pixels, alpha } = image.image;
  let smask = '';
  if (alpha) {
    const mask = await pdf.stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha);
    smask = ` /SMask ${ref(mask)}`;
  }
  return pdf.stream(
    `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colors === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8${smask}`,
    pixels,
  );
}

function jpegColorSpace(components: number): string {
  if (components === 1) return '/DeviceGray';
  return components === 3 ? '/DeviceRGB' : '/DeviceCMYK';
}

/** A URI as 7-bit ASCII (PDF URIs are bytes): anything else percent-encoded as UTF-8. */
function uriBytes(uri: string): string {
  let out = '';
  for (const ch of uri) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x20 && cp < 0x7f) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// ---------------------------------------------------------------- outlines

interface OutlineNode {
  title: string;
  level: number;
  page: number;
  top: number;
  children: OutlineNode[];
}

type PlacedItem = PageLayout['columns'][number]['items'][number];

/** The headings of the laid-out pages, nested by level under a root. */
function outlineTree(dl: DocLayout, pages: PageLayout[]): OutlineNode {
  const root: OutlineNode = { title: '', level: -1, page: 0, top: 0, children: [] };
  const stack: OutlineNode[] = [root];
  pages.forEach((page, pi) => {
    for (const area of page.columns) {
      for (const item of area.items) {
        const heading = headingAt(dl, item);
        if (!heading) continue;
        const { title, level } = heading;
        while (stack.length > 1 && stack[stack.length - 1]!.level >= level) stack.pop();
        const node: OutlineNode = { title, level, page: pi, top: page.height - item.y, children: [] };
        stack[stack.length - 1]!.children.push(node);
        stack.push(node);
      }
    }
  });
  return root;
}

/** The title and outline level of a heading's first line; null for any other item. */
function headingAt(dl: DocLayout, item: PlacedItem): { title: string; level: number } | null {
  if (item.kind !== 'lines' || item.story !== BODY || item.block !== 0 || item.from !== 0) return null;
  const layout = item.entry.layout;
  if (!layout) return null;
  const level = outlineLevel(dl.doc, layout.props);
  if (level === null) return null;
  const title = dl.doc.body
    .text(item.entry.start, item.entry.end)
    .split(OBJECT)
    .join('')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 250);
  return title ? { title, level } : null;
}

/** Bookmarks from headings (paragraphs whose style has an outline level), nested by level. */
function writeOutlines(pdf: PdfWriter, dl: DocLayout, pages: PageLayout[], pageRefs: number[]): number | null {
  const root = outlineTree(dl, pages);
  if (!root.children.length) return null;

  const outlines = pdf.alloc();
  const count = (n: OutlineNode): number => n.children.reduce((s, ch) => s + 1 + count(ch), 0);
  const write = (nodes: OutlineNode[], parent: number): { first: number; last: number } => {
    const ids = nodes.map(() => pdf.alloc());
    nodes.forEach((node, i) => {
      let dict = `/Title ${textString(node.title)} /Parent ${ref(parent)} /Dest [${ref(pageRefs[node.page]!)} /XYZ null ${num(node.top)} null]`;
      if (i > 0) dict += ` /Prev ${ref(ids[i - 1]!)}`;
      if (i < nodes.length - 1) dict += ` /Next ${ref(ids[i + 1]!)}`;
      if (node.children.length) {
        const kids = write(node.children, ids[i]!);
        dict += ` /First ${ref(kids.first)} /Last ${ref(kids.last)} /Count ${count(node)}`;
      }
      pdf.set(ids[i]!, `<< ${dict} >>`);
    });
    return { first: ids[0]!, last: ids[ids.length - 1]! };
  };
  const top = write(root.children, outlines);
  pdf.set(outlines, `<< /Type /Outlines /First ${ref(top.first)} /Last ${ref(top.last)} /Count ${count(root)} >>`);
  return outlines;
}
