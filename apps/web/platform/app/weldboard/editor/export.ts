/**
 * Exports made in the browser from the engine's display list: PNG (the board,
 * a frame or the selection), SVG (images embedded, so the file stands alone),
 * PDF (one page, or one page per frame) and the board's own JSON.
 */

import {
  boardDisplay,
  displayToSvg,
  selectionBounds,
  type Board,
  type DisplayItem,
  type Rect,
} from '@weldsuite/board-engine';
import type { BoardController } from './model/board-controller';
import { BoardRenderer } from './view/renderer';

export type ExportFormat = 'png' | 'svg' | 'pdf' | 'pdf-frames' | 'json';

export interface ExportContext {
  controller: BoardController;
  name: string;
  /** Loads an image source into a URL the browser can draw (an object URL for private files). */
  loadImage: (src: string) => Promise<string | null>;
  /** Only these elements (the selection); default the whole board. */
  only?: ReadonlySet<string>;
}

const MAX_PIXELS = 8192;

function area(board: Board, only?: ReadonlySet<string>): Rect | null {
  return selectionBounds(board, only ?? board.elements.keys());
}

function safeName(name: string): string {
  return (name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'board').slice(0, 120);
}

export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function imageSources(items: DisplayItem[], out = new Set<string>()): Set<string> {
  for (const item of items) {
    if (item.kind === 'image') out.add(item.src);
    else if (item.kind === 'group') imageSources(item.items, out);
  }
  return out;
}

async function loadAll(sources: Iterable<string>, load: (src: string) => Promise<string | null>): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  await Promise.all(
    [...sources].map(async (src) => {
      const url = await load(src).catch(() => null);
      if (!url) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = url;
      });
      if (img.naturalWidth) out.set(src, img);
    }),
  );
  return out;
}

/** Draws an area of the board into a canvas at `scale` px per board unit. */
export async function renderArea(ctx: ExportContext, r: Rect, scale: number, background = '#ffffff'): Promise<HTMLCanvasElement> {
  const c = ctx.controller;
  const pad = 32;
  const w = Math.min(MAX_PIXELS, Math.ceil((r.w + pad * 2) * scale));
  const h = Math.min(MAX_PIXELS, Math.ceil((r.h + pad * 2) * scale));
  const s = Math.min(w / (r.w + pad * 2), h / (r.h + pad * 2));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = background;
  g.fillRect(0, 0, w, h);
  const items = boardDisplay(c.board, { measurer: c.measurer, name: (id) => c.names.get(id) ?? null, imageSrc: (src) => src, showAuthors: c.showAuthors }, ctx.only);
  const images = await loadAll(imageSources(items), ctx.loadImage);
  const renderer = new BoardRenderer(c, {
    loadImage: async () => null,
    requestRedraw: () => undefined,
  });
  renderer.seedImages(images);
  g.scale(s, s);
  g.translate(-r.x + pad, -r.y + pad);
  renderer.drawItems(g, items, { text: true, shadows: true });
  return canvas;
}

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function svgOf(ctx: ExportContext, r: Rect): Promise<string> {
  const c = ctx.controller;
  const items = boardDisplay(c.board, { measurer: c.measurer, name: (id) => c.names.get(id) ?? null, imageSrc: (src) => src, showAuthors: c.showAuthors }, ctx.only);
  // Embed images, so the SVG opens anywhere.
  const sources = imageSources(items);
  const embedded = new Map<string, string>();
  await Promise.all(
    [...sources].map(async (src) => {
      const url = await ctx.loadImage(src).catch(() => null);
      const data = url ? await toDataUrl(url) : null;
      if (data) embedded.set(src, data);
    }),
  );
  const swap = (list: DisplayItem[]): DisplayItem[] =>
    list.map((item) => (item.kind === 'image' ? { ...item, src: embedded.get(item.src) ?? item.src } : item.kind === 'group' ? { ...item, items: swap(item.items) } : item));
  return displayToSvg(swap(items), { view: r, background: '#ffffff', padding: 32 });
}

export async function exportBoard(ctx: ExportContext, format: ExportFormat): Promise<'empty' | 'done'> {
  const c = ctx.controller;
  const name = safeName(ctx.name);
  if (format === 'json') {
    const snapshot = c.board.toSnapshot();
    download(new Blob([JSON.stringify({ kind: 'weldboard', name: ctx.name, snapshot })], { type: 'application/json' }), `${name}.weldboard.json`);
    return 'done';
  }
  const r = area(c.board, ctx.only);
  if (!r) return 'empty';
  if (format === 'svg') {
    download(new Blob([await svgOf(ctx, r)], { type: 'image/svg+xml' }), `${name}.svg`);
    return 'done';
  }
  if (format === 'png') {
    const scale = Math.min(2, MAX_PIXELS / Math.max(r.w, r.h, 1));
    const canvas = await renderArea(ctx, r, scale);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) download(blob, `${name}.png`);
    return 'done';
  }
  const { boardPdf } = await import('./pdf');
  const bytes = await boardPdf(ctx, format === 'pdf-frames');
  if (!bytes) return 'empty';
  download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${name}.pdf`);
  return 'done';
}

/** Copies the selection (or the board) to the clipboard as a PNG. */
export async function copyAsImage(ctx: ExportContext): Promise<boolean> {
  const r = area(ctx.controller.board, ctx.only);
  if (!r || typeof ClipboardItem === 'undefined') return false;
  const canvas = await renderArea(ctx, r, 2);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return false;
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return true;
}
