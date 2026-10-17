/**
 * PDF painter (pdf-lib, standard fonts): draws a layout from `./layout`.
 * Runs in the browser and in Workers alike.
 */
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { drawableText, standardFontName, textWidth, type FontFace } from './fonts';
import type { InvoiceLayout, Primitive } from './layout';
import { safeImageSrc } from './layout';

export interface PdfPaintOptions {
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

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return `M${x + rr} ${y} H${x + w - rr} Q${x + w} ${y} ${x + w} ${y + rr} V${y + h - rr} Q${x + w} ${y + h} ${x + w - rr} ${y + h} H${x + rr} Q${x} ${y + h} ${x} ${y + h - rr} V${y + rr} Q${x} ${y} ${x + rr} ${y} Z`;
}

export async function renderInvoicePdf(layout: InvoiceLayout, options: PdfPaintOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  if (options.title) pdf.setTitle(options.title);
  const H = layout.height;

  const fonts = new Map<string, PDFFont>();
  const fontFor = async (face: FontFace) => {
    const name = standardFontName(face);
    let font = fonts.get(name);
    if (!font) {
      font = await pdf.embedFont(name);
      fonts.set(name, font);
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

type DrawCtx = { H: number; width: number; fontFor: (face: FontFace) => Promise<PDFFont>; imageFor: (src: string) => Promise<PDFImage | null> };
type Of<K extends Primitive['kind']> = Extract<Primitive, { kind: K }>;

async function drawPrimitive(page: PDFPage, p: Primitive, ctx: DrawCtx) {
  const { H } = ctx;
  switch (p.kind) {
    case 'text': {
      const font = await ctx.fontFor(p.face);
      page.drawText(drawableText(p.text), { x: p.x, y: H - p.y, size: p.size, font, color: hex(p.color) });
      return;
    }
    case 'rect':
      drawRect(page, p, H);
      return;
    case 'line':
      page.drawLine({ start: { x: p.x1, y: H - p.y1 }, end: { x: p.x2, y: H - p.y2 }, thickness: p.width, color: hex(p.color) });
      return;
    case 'image':
      await drawImage(page, p, ctx);
      return;
    case 'qr':
      drawQr(page, p, H);
      return;
    case 'watermark':
      await drawWatermark(page, p, ctx);
      return;
  }
}

function drawRect(page: PDFPage, p: Of<'rect'>, H: number) {
  const fill = p.fill ? hex(p.fill) : undefined;
  const border = p.stroke ? hex(p.stroke) : undefined;
  const borderWidth = p.stroke ? (p.strokeWidth ?? 1) : 0;
  if (p.radius) {
    page.drawSvgPath(roundedRectPath(p.x, p.y, p.w, p.h, p.radius), { x: 0, y: H, color: fill, borderColor: border, borderWidth });
  } else {
    page.drawRectangle({ x: p.x, y: H - p.y - p.h, width: p.w, height: p.h, color: fill, borderColor: border, borderWidth });
  }
}

/** Left edge of something `w` wide aligned in a box at `x`, `boxW` wide. */
const ALIGNED_X = {
  left: (x: number) => x,
  center: (x: number, boxW: number, w: number) => x + (boxW - w) / 2,
  right: (x: number, boxW: number, w: number) => x + boxW - w,
} as const;

async function drawImage(page: PDFPage, p: Of<'image'>, ctx: DrawCtx) {
  const src = safeImageSrc(p.src);
  const image = src ? await ctx.imageFor(src) : null;
  if (!image) return;
  const scale = Math.min(p.w / image.width, p.h / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  const x = ALIGNED_X[p.align](p.x, p.w, w);
  const y = p.y + (p.h - h) / 2;
  page.drawImage(image, { x, y: ctx.H - y - h, width: w, height: h });
}

function drawQr(page: PDFPage, p: Of<'qr'>, H: number) {
  const cell = p.size / Math.max(1, p.matrix.length);
  page.drawRectangle({ x: p.x, y: H - p.y - p.size, width: p.size, height: p.size, color: rgb(1, 1, 1) });
  p.matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      page.drawRectangle({ x: p.x + c * cell, y: H - p.y - (r + 1) * cell, width: cell + 0.15, height: cell + 0.15, color: rgb(0, 0, 0) });
    }),
  );
}

async function drawWatermark(page: PDFPage, p: Of<'watermark'>, ctx: DrawCtx) {
  const font = await ctx.fontFor(p.face);
  const text = drawableText(p.text);
  const w = textWidth(text, p.size, p.face);
  const angle = (30 * Math.PI) / 180;
  const cx = ctx.width / 2;
  const cy = ctx.H / 2;
  // Start so the rotated run is centred on the page (baseline through the centre, shifted by a third of the size).
  const x = cx - (w / 2) * Math.cos(angle) + (p.size / 3) * Math.sin(angle);
  const y = cy - (w / 2) * Math.sin(angle) - (p.size / 3) * Math.cos(angle);
  page.drawText(text, { x, y, size: p.size, font, color: hex(p.color), opacity: 0.08, rotate: degrees(30) });
}
