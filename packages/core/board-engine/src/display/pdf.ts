/**
 * A board as a PDF, vector all the way: one page with the whole board, or
 * one page per frame (in presentation order). Drawn from the same display
 * list as the screen, on docs-engine's PDF writer. Text uses the standard
 * fonts (Latin text; other characters show as '?'), stretched to the width
 * the layout gave it, so it lines up with the shapes around it.
 */

import {
  ContentStream,
  FIRST_CHAR,
  LAST_CHAR,
  MetricsMeasurer,
  PdfWriter,
  dataUrlBytes,
  latin1,
  literal,
  name,
  num,
  parseColor,
  pdfDate,
  readImage,
  ref,
  roundWidth,
  standardFont,
  standardWidths,
  textString,
  winAnsiCode,
  writeImage,
  type Rgb,
  type StandardFontName,
} from '@weldsuite/docs-engine';
import { selectionBounds } from '../geometry/bounds';
import type { PathCmd, Rect } from '../geometry/path';
import type { Board } from '../model/board';
import { boardDisplay, type DisplayItem, type DisplayOptions } from './display';

export interface BoardPdfOptions {
  title?: string;
  /** One page per frame instead of one page with everything. */
  perFrame?: boolean;
  /** Fetches an image's bytes by its source. */
  images?: (src: string) => Promise<{ bytes: Uint8Array } | null>;
  display?: Omit<DisplayOptions, 'measurer'>;
  date?: Date;
}

/** PDF pages are at most 14,400 units on a side. */
const MAX_PAGE = 14_000;
const PAD = 24;

interface Page {
  area: Rect;
  only?: ReadonlySet<string>;
}

function pagesOf(board: Board, perFrame: boolean): Page[] {
  if (perFrame) {
    const frames = [...board.elements.values()].filter((e) => e.type === 'frame');
    const slides = frames.filter((f) => f.slide !== undefined).sort((a, b) => a.slide! - b.slide!);
    const ordered = slides.length ? slides : frames.sort((a, b) => a.y - b.y || a.x - b.x);
    if (ordered.length) {
      return ordered.map((f) => {
        const only = new Set([f.id, ...board.descendants(f.id)]);
        // Connectors between the frame's contents come along.
        for (const el of board.elements.values()) {
          if (el.type === 'connector' && el.start?.el && el.end?.el && only.has(el.start.el) && only.has(el.end.el)) only.add(el.id);
        }
        return { area: { x: f.x, y: f.y - 24, w: f.w, h: f.h + 24 }, only };
      });
    }
  }
  const all = selectionBounds(board, board.elements.keys());
  return all ? [{ area: all }] : [];
}

class Writer {
  private readonly fonts = new Map<StandardFontName, string>();
  private readonly alphas = new Map<string, string>();
  private readonly images = new Map<string, Promise<string | null>>();
  private readonly imageRefs = new Map<string, number>();
  private readonly widths = new Map<StandardFontName, number[]>();
  private readonly measurer = new MetricsMeasurer();

  constructor(
    private readonly pdf: PdfWriter,
    private readonly options: BoardPdfOptions,
  ) {}

  private font(f: StandardFontName): string {
    let res = this.fonts.get(f);
    if (!res) {
      res = `F${this.fonts.size + 1}`;
      this.fonts.set(f, res);
    }
    return res;
  }

  private widthsOf(f: StandardFontName): number[] {
    let w = this.widths.get(f);
    if (!w) {
      w = standardWidths(f, this.measurer);
      this.widths.set(f, w);
    }
    return w;
  }

  private alpha(a: number): string {
    const key = a.toFixed(3);
    let res = this.alphas.get(key);
    if (!res) {
      res = `GS${this.alphas.size + 1}`;
      this.alphas.set(key, res);
    }
    return res;
  }

  private image(src: string): Promise<string | null> {
    let p = this.images.get(src);
    if (!p) {
      p = (async () => {
        try {
          const bytes = dataUrlBytes(src) ?? (await this.options.images?.(src))?.bytes;
          const image = bytes ? await readImage(bytes) : null;
          if (!image) return null;
          const res = `Im${this.imageRefs.size + 1}`;
          this.imageRefs.set(res, await writeImage(this.pdf, image));
          return res;
        } catch {
          return null;
        }
      })();
      this.images.set(src, p);
    }
    return p;
  }

  private path(c: ContentStream, cmds: PathCmd[]): void {
    let last: [number, number] = [0, 0];
    for (const cmd of cmds) {
      switch (cmd[0]) {
        case 'M':
          c.op(`${num(cmd[1])} ${num(c.y(cmd[2]))} m`);
          last = [cmd[1], cmd[2]];
          break;
        case 'L':
          c.op(`${num(cmd[1])} ${num(c.y(cmd[2]))} l`);
          last = [cmd[1], cmd[2]];
          break;
        case 'C':
          c.op(`${num(cmd[1])} ${num(c.y(cmd[2]))} ${num(cmd[3])} ${num(c.y(cmd[4]))} ${num(cmd[5])} ${num(c.y(cmd[6]))} c`);
          last = [cmd[5], cmd[6]];
          break;
        case 'Q': {
          // A quadratic as a cubic.
          const [x0, y0] = last;
          const c1x = x0 + (2 / 3) * (cmd[1] - x0);
          const c1y = y0 + (2 / 3) * (cmd[2] - y0);
          const c2x = cmd[3] + (2 / 3) * (cmd[1] - cmd[3]);
          const c2y = cmd[4] + (2 / 3) * (cmd[2] - cmd[4]);
          c.op(`${num(c1x)} ${num(c.y(c1y))} ${num(c2x)} ${num(c.y(c2y))} ${num(cmd[3])} ${num(c.y(cmd[4]))} c`);
          last = [cmd[3], cmd[4]];
          break;
        }
        case 'Z':
          c.op('h');
          break;
      }
    }
  }

  async draw(c: ContentStream, items: DisplayItem[], alpha = 1): Promise<void> {
    for (const item of items) {
      switch (item.kind) {
        case 'path': {
          const fill = item.fill ? parseColor(item.fill) : null;
          const stroke = item.stroke && item.width ? parseColor(item.stroke) : null;
          if (!fill && !stroke) break;
          c.op('q');
          const a = alpha * (item.opacity ?? 1);
          if (a < 0.999) c.op(`/${this.alpha(a)} gs`);
          if (fill) c.fillColor(fill);
          if (stroke) {
            c.strokeColor(stroke);
            c.op(`${num(item.width!)} w`);
            if (item.round) c.op('1 J 1 j');
            if (item.dash?.length) c.op(`[${item.dash.map(num).join(' ')}] 0 d`);
          }
          this.path(c, item.cmds);
          c.op(fill && stroke ? 'B' : fill ? 'f' : 'S');
          c.op('Q');
          break;
        }
        case 'text':
          this.text(c, item, alpha);
          break;
        case 'image': {
          const res = await this.image(item.src);
          c.op('q');
          c.op(`${num(item.x)} ${num(c.y(item.y + item.h))} ${num(item.w)} ${num(item.h)} re W n`);
          if (res) {
            const crop = item.crop ?? { x: 0, y: 0, w: 1, h: 1 };
            const fw = item.w / crop.w;
            const fh = item.h / crop.h;
            const fx = item.x - crop.x * fw;
            const fy = item.y - crop.y * fh;
            c.op(`${num(fw)} 0 0 ${num(fh)} ${num(fx)} ${num(c.y(fy + fh))} cm /${res} Do`);
          } else {
            c.fillColor([0.93, 0.94, 0.95]);
            c.op(`${num(item.x)} ${num(c.y(item.y + item.h))} ${num(item.w)} ${num(item.h)} re f`);
          }
          c.op('Q');
          break;
        }
        case 'group': {
          c.op('q');
          if (item.rotate) {
            // Rotate around the centre; PDF's y axis points up, so the angle flips.
            const a = -item.rotate.angle;
            const cx = item.rotate.cx;
            const cy = c.y(item.rotate.cy);
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            c.op(`1 0 0 1 ${num(cx)} ${num(cy)} cm ${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} 0 0 cm 1 0 0 1 ${num(-cx)} ${num(-cy)} cm`);
          }
          await this.draw(c, item.items, alpha * (item.opacity ?? 1));
          c.op('Q');
          break;
        }
      }
    }
  }

  private text(c: ContentStream, item: Extract<DisplayItem, { kind: 'text' }>, alpha: number): void {
    const color: Rgb = parseColor(item.color) ?? [0, 0, 0];
    const f = standardFont(item.font);
    const widths = this.widthsOf(f);
    let bytes = '';
    let natural = 0;
    for (const ch of item.text) {
      const code = winAnsiCode(ch.codePointAt(0)!) ?? 63;
      bytes += String.fromCharCode(code);
      natural += ((code >= FIRST_CHAR && code <= LAST_CHAR ? widths[code - FIRST_CHAR] : 500) ?? 500) * item.font.size / 1000;
    }
    if (!bytes) return;
    c.op('q');
    if (alpha < 0.999) c.op(`/${this.alpha(alpha)} gs`);
    if (item.highlight) {
      const hl = parseColor(item.highlight.color);
      if (hl) {
        c.fillColor(hl);
        c.op(`${num(item.x)} ${num(c.y(item.y + item.font.size * 0.3))} ${num(item.width)} ${num(item.font.size * 1.25)} re f`);
      }
    }
    c.fillColor(color);
    // Stretch to the layout's width, within reason.
    const tz = natural > 0 ? Math.max(50, Math.min(150, (item.width / natural) * 100)) : 100;
    c.op(`BT /${this.font(f)} ${num(item.font.size)} Tf ${num(tz)} Tz ${num(item.x)} ${num(c.y(item.y))} Td ${literal(bytes)} Tj ET`);
    const thick = Math.max(0.4, item.font.size / 16);
    if (item.underline) c.op(`${num(item.x)} ${num(c.y(item.y + item.font.size * 0.12 + thick))} ${num(item.width)} ${num(thick)} re f`);
    if (item.strike) c.op(`${num(item.x)} ${num(c.y(item.y - item.font.size * 0.3 + thick / 2))} ${num(item.width)} ${num(thick)} re f`);
    c.op('Q');
  }

  resources(): string {
    const fonts: string[] = [];
    for (const [f, res] of this.fonts) {
      const widths = this.widthsOf(f).map((w) => num(roundWidth(w)));
      const n = this.pdf.add(`<< /Type /Font /Subtype /Type1 /BaseFont ${name(f)} /Encoding /WinAnsiEncoding /FirstChar ${FIRST_CHAR} /LastChar ${LAST_CHAR} /Widths [${widths.join(' ')}] >>`);
      fonts.push(`/${res} ${ref(n)}`);
    }
    const states = [...this.alphas].map(([a, res]) => `/${res} << /Type /ExtGState /ca ${a} /CA ${a} >>`);
    const xobjects = [...this.imageRefs].map(([res, n]) => `/${res} ${ref(n)}`);
    return (
      `<< /ProcSet [/PDF /Text /ImageB /ImageC] /Font << ${fonts.join(' ')} >>` +
      (states.length ? ` /ExtGState << ${states.join(' ')} >>` : '') +
      (xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : '') +
      ' >>'
    );
  }
}

/** The PDF, or null when the board has nothing on it. */
export async function boardToPdf(board: Board, options: BoardPdfOptions = {}): Promise<Uint8Array | null> {
  const pages = pagesOf(board, !!options.perFrame);
  if (!pages.length) return null;
  const date = options.date ?? new Date();
  const pdf = new PdfWriter();
  const catalog = pdf.alloc();
  const pagesRef = pdf.alloc();
  const resources = pdf.alloc();
  const w = new Writer(pdf, options);
  const measurer = new MetricsMeasurer();
  const refs: number[] = [];
  for (const page of pages) {
    const width = page.area.w + PAD * 2;
    const height = page.area.h + PAD * 2;
    const scale = Math.min(1, MAX_PAGE / Math.max(width, height));
    const pw = width * scale;
    const ph = height * scale;
    // `inner` draws in board units, flipped against the unscaled page height;
    // one `cm` then scales it and moves the area's corner to the padding:
    // X = (bx - area.x + PAD)·scale, Y = ph - (by - area.y + PAD)·scale.
    const inner = new ContentStream(height);
    const items = boardDisplay(board, { ...options.display, measurer }, page.only);
    await w.draw(inner, items);
    const body = `q ${num(scale)} 0 0 ${num(scale)} ${num((PAD - page.area.x) * scale)} ${num((page.area.y - PAD) * scale)} cm\n${inner.text}\nQ`;
    const contents = await pdf.stream('', latin1(body));
    refs.push(pdf.add(`<< /Type /Page /Parent ${ref(pagesRef)} /MediaBox [0 0 ${num(pw)} ${num(ph)}] /Resources ${ref(resources)} /Contents ${ref(contents)} >>`));
  }
  pdf.set(resources, w.resources());
  pdf.set(pagesRef, `<< /Type /Pages /Kids [${refs.map(ref).join(' ')}] /Count ${refs.length} >>`);
  let info = `/Producer (WeldBoard) /Creator (WeldBoard) /CreationDate ${literal(pdfDate(date))}`;
  if (options.title) info += ` /Title ${textString(options.title)}`;
  const infoRef = pdf.add(`<< ${info} >>`);
  pdf.set(catalog, `<< /Type /Catalog /Pages ${ref(pagesRef)}${options.title ? ' /ViewerPreferences << /DisplayDocTitle true >>' : ''} >>`);
  return pdf.finish(catalog, infoRef);
}
