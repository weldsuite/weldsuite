/**
 * PDF painter (pdf-lib): draws a layout from `./layout` with the bundled Noto
 * fonts, each embedded as a subset of the glyphs the invoice uses.
 * Runs in the browser and in Workers alike; the caller supplies the font
 * bytes (`loadFont`), since how a file is reached differs per runtime.
 */
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { FONT_METRICS, drawableText, faceKeyOf, isSlanted, textWidth, type FontFace, type FontFaceKey } from './fonts';
import type { InvoiceLayout, Primitive } from './layout';
import { safeImageSrc } from './layout';

export interface PdfPaintOptions {
  /** The bytes of a bundled font file: a name under `./fonts`, e.g. `noto-sans-regular.ttf`. */
  loadFont: (file: string) => Promise<Uint8Array | ArrayBuffer>;
  /** Loads an image's bytes; defaults to `fetch` (and decodes data: URLs). Return null to skip the image. */
  loadImage?: (src: string) => Promise<Uint8Array | null>;
  title?: string;
}

function hex(value: string | undefined, fallback: RGB = rgb(0, 0, 0)): RGB {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? '');
  if (!m) return fallback;
  return rgb(Number.parseInt(m[1], 16) / 255, Number.parseInt(m[2], 16) / 255, Number.parseInt(m[3], 16) / 255);
}

async function defaultLoadImage(src: string): Promise<Uint8Array | null> {
  try {
    const data = /^data:image\/[a-z]+;base64,(.*)$/i.exec(src);
    if (data) {
      const bin = atob(data[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    const res = await fetch(src);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function embedImage(pdf: PDFDocument, bytes: Uint8Array): Promise<PDFImage | null> {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await pdf.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await pdf.embedJpg(bytes);
  } catch {
    // Unreadable image: leave it out rather than failing the invoice.
  }
  return null;
}

/** Italic mono runs: the upright face at the slant of a browser's synthesised oblique. */
function slantOf(face: FontFace): { ySkew?: ReturnType<typeof degrees> } {
  return isSlanted(face) ? { ySkew: degrees(14) } : {};
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return `M${x + rr} ${y} H${x + w - rr} Q${x + w} ${y} ${x + w} ${y + rr} V${y + h - rr} Q${x + w} ${y + h} ${x + w - rr} ${y + h} H${x + rr} Q${x} ${y + h} ${x} ${y + h - rr} V${y + rr} Q${x} ${y} ${x + rr} ${y} Z`;
}

export async function renderInvoicePdf(layout: InvoiceLayout, options: PdfPaintOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  if (options.title) pdf.setTitle(options.title);
  const H = layout.height;

  const fonts = new Map<FontFaceKey, Promise<PDFFont>>();
  const fontFor = (face: FontFace) => {
    const key = faceKeyOf(face);
    let font = fonts.get(key);
    if (!font) {
      font = options.loadFont(FONT_METRICS[key].file).then((bytes) => pdf.embedFont(bytes, { subset: true }));
      fonts.set(key, font);
    }
    return font;
  };

  const images = new Map<string, Promise<PDFImage | null>>();
  const imageFor = (src: string) => {
    let image = images.get(src);
    if (!image) {
      image = (options.loadImage ?? defaultLoadImage)(src).then((bytes) => (bytes ? embedImage(pdf, bytes) : null));
      images.set(src, image);
    }
    return image;
  };

  for (const pageLayout of layout.pages) {
    const page = pdf.addPage([layout.width, layout.height]);
    for (const p of pageLayout.primitives) {
      await drawPrimitive(page, p, { H, width: layout.width, fontFor, imageFor });
    }
  }
  return await pdf.save();
}

async function drawPrimitive(
  page: PDFPage,
  p: Primitive,
  ctx: { H: number; width: number; fontFor: (face: FontFace) => Promise<PDFFont>; imageFor: (src: string) => Promise<PDFImage | null> },
) {
  const { H } = ctx;
  switch (p.kind) {
    case 'text': {
      const font = await ctx.fontFor(p.face);
      page.drawText(drawableText(p.text, p.face), { x: p.x, y: H - p.y, size: p.size, font, color: hex(p.color), ...slantOf(p.face) });
      return;
    }
    case 'rect': {
      const fill = p.fill ? hex(p.fill) : undefined;
      const border = p.stroke ? hex(p.stroke) : undefined;
      const borderWidth = p.stroke ? (p.strokeWidth ?? 1) : 0;
      if (p.radius) {
        page.drawSvgPath(roundedRectPath(p.x, p.y, p.w, p.h, p.radius), { x: 0, y: H, color: fill, borderColor: border, borderWidth });
      } else {
        page.drawRectangle({ x: p.x, y: H - p.y - p.h, width: p.w, height: p.h, color: fill, borderColor: border, borderWidth });
      }
      return;
    }
    case 'line':
      page.drawLine({ start: { x: p.x1, y: H - p.y1 }, end: { x: p.x2, y: H - p.y2 }, thickness: p.width, color: hex(p.color) });
      return;
    case 'image': {
      const src = safeImageSrc(p.src);
      const image = src ? await ctx.imageFor(src) : null;
      if (!image) return;
      const scale = Math.min(p.w / image.width, p.h / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      const x = p.align === 'right' ? p.x + p.w - w : p.align === 'center' ? p.x + (p.w - w) / 2 : p.x;
      const y = p.y + (p.h - h) / 2;
      page.drawImage(image, { x, y: H - y - h, width: w, height: h });
      return;
    }
    case 'qr': {
      const cell = p.size / Math.max(1, p.matrix.length);
      page.drawRectangle({ x: p.x, y: H - p.y - p.size, width: p.size, height: p.size, color: rgb(1, 1, 1) });
      p.matrix.forEach((row, r) =>
        row.forEach((dark, c) => {
          if (!dark) return;
          page.drawRectangle({ x: p.x + c * cell, y: H - p.y - (r + 1) * cell, width: cell + 0.15, height: cell + 0.15, color: rgb(0, 0, 0) });
        }),
      );
      return;
    }
    case 'watermark': {
      const font = await ctx.fontFor(p.face);
      const text = drawableText(p.text, p.face);
      const w = textWidth(text, p.size, p.face);
      const angle = (30 * Math.PI) / 180;
      const cx = ctx.width / 2;
      const cy = H / 2;
      // Start so the rotated run is centred on the page (baseline through the centre, shifted by a third of the size).
      const x = cx - (w / 2) * Math.cos(angle) + (p.size / 3) * Math.sin(angle);
      const y = cy - (w / 2) * Math.sin(angle) - (p.size / 3) * Math.cos(angle);
      page.drawText(text, { x, y, size: p.size, font, color: hex(p.color), opacity: 0.08, rotate: degrees(30) });
      return;
    }
  }
}
