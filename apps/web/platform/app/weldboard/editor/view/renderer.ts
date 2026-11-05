/**
 * Draws the board on a canvas from the engine's display list: only what is
 * in view, element draw lists cached by element (elements are replaced on
 * change, so identity is the cache key), Path2D objects cached per item,
 * less detail when zoomed far out. Images load in the background and redraw
 * when ready.
 */

import {
  elementDisplay,
  isCollapsedAway,
  type BoardElement,
  type DisplayItem,
  type RecordRef,
  type RecordView,
} from '@weldsuite/board-engine';
import { cssFont } from '@weldsuite/docs-engine';
import type { BoardController } from '../model/board-controller';

export interface RendererOptions {
  /** Loads an image source (resolving `drive:` and private files) into an object URL. */
  loadImage: (src: string) => Promise<string | null>;
  record?: (ref: RecordRef) => RecordView | null;
  requestRedraw: () => void;
}

interface Cached {
  el: BoardElement;
  deps: unknown[];
  items: DisplayItem[];
}

const pathCache = new WeakMap<DisplayItem, Path2D>();

function toPath2D(item: Extract<DisplayItem, { kind: 'path' }>): Path2D {
  let p = pathCache.get(item);
  if (p) return p;
  p = new Path2D();
  for (const c of item.cmds) {
    switch (c[0]) {
      case 'M':
        p.moveTo(c[1], c[2]);
        break;
      case 'L':
        p.lineTo(c[1], c[2]);
        break;
      case 'C':
        p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
        break;
      case 'Q':
        p.quadraticCurveTo(c[1], c[2], c[3], c[4]);
        break;
      case 'Z':
        p.closePath();
        break;
    }
  }
  pathCache.set(item, p);
  return p;
}

export class BoardRenderer {
  private readonly cache = new Map<string, Cached>();
  private readonly images = new Map<string, HTMLImageElement | 'loading' | 'error'>();
  recordVersion = 0;

  constructor(
    private readonly c: BoardController,
    private readonly options: RendererOptions,
  ) {}

  private imageFor(src: string): HTMLImageElement | null {
    const got = this.images.get(src);
    if (got instanceof HTMLImageElement) return got;
    if (got) return null;
    this.images.set(src, 'loading');
    this.options
      .loadImage(src)
      .then((url) => {
        if (!url) {
          this.images.set(src, 'error');
          return;
        }
        const img = new Image();
        img.onload = () => {
          this.images.set(src, img);
          this.options.requestRedraw();
        };
        img.onerror = () => this.images.set(src, 'error');
        img.src = url;
      })
      .catch(() => this.images.set(src, 'error'));
    return null;
  }

  /** Images loaded elsewhere (an export waits for them before drawing). */
  seedImages(images: Map<string, HTMLImageElement>): void {
    for (const [src, img] of images) this.images.set(src, img);
  }

  private deps(el: BoardElement): unknown[] {
    const c = this.c;
    if (el.type === 'connector') return [el, el.start?.el ? c.board.get(el.start.el) : null, el.end?.el ? c.board.get(el.end.el) : null];
    if (el.type === 'record') return [el, this.recordVersion];
    if (el.type === 'sticky' || el.type === 'card') return [el, c.showAuthors, c.names.size];
    return [el];
  }

  private itemsFor(el: BoardElement): DisplayItem[] {
    const deps = this.deps(el);
    const hit = this.cache.get(el.id);
    if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) return hit.items;
    const c = this.c;
    const items = elementDisplay(c.board, el, {
      measurer: c.measurer,
      name: (id) => c.names.get(id) ?? null,
      record: this.options.record,
      // The renderer draws images itself, from its own cache.
      imageSrc: (src) => src,
      showAuthors: c.showAuthors,
    });
    this.cache.set(el.id, { el, deps, items });
    return items;
  }

  /** Forget cached drawings of elements that are gone (call now and then). */
  prune(): void {
    for (const id of this.cache.keys()) if (!this.c.board.get(id)) this.cache.delete(id);
  }

  invalidateRecords(): void {
    this.recordVersion++;
    this.options.requestRedraw();
  }

  /** The board's content, in a context already cleared and scaled for the device pixel ratio. */
  drawContent(ctx: CanvasRenderingContext2D, width: number, height: number, options: { hidden?: ReadonlySet<string>; faded?: ReadonlySet<string>; background?: string } = {}): void {
    const c = this.c;
    const cam = c.camera;
    ctx.fillStyle = options.background ?? c.board.props.background ?? '#f7f8fa';
    ctx.fillRect(0, 0, width, height);
    if (c.showGrid && c.board.props.grid !== 'none') this.drawGrid(ctx, width, height, c.board.props.grid ?? 'dots');

    ctx.save();
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
    const view = c.visible();
    const pad = 64 / cam.zoom;
    const visible = c.index.query({ x: view.x - pad, y: view.y - pad, w: view.w + pad * 2, h: view.h + pad * 2 });
    const lod = { text: cam.zoom >= 0.12, shadows: cam.zoom >= 0.25 && visible.size < 600 };
    const me = c.options.userId;
    const privateMode = !!c.board.props.privateMode;
    for (const el of c.board.paintOrder()) {
      if (!visible.has(el.id) || options.hidden?.has(el.id)) continue;
      if (el.mindmap?.parent && isCollapsedAway(c.board, el)) continue;
      if (el.type === 'comment') continue; // Pins are drawn on the overlay, on top of everything.
      if (privateMode && el.type === 'sticky' && el.createdBy && el.createdBy !== me) {
        this.drawHidden(ctx, el);
        continue;
      }
      ctx.globalAlpha = options.faded?.has(el.id) ? 0.3 : 1;
      this.drawItems(ctx, this.itemsFor(el), lod);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawHidden(ctx: CanvasRenderingContext2D, el: BoardElement): void {
    ctx.fillStyle = '#e5e7eb';
    ctx.beginPath();
    ctx.roundRect(el.x, el.y, el.w, el.h, 4);
    ctx.fill();
    ctx.strokeStyle = '#9ca3af';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, kind: 'dots' | 'lines'): void {
    const cam = this.c.camera;
    let step = 24;
    while (step * cam.zoom < 12) step *= 4;
    const s = step * cam.zoom;
    const ox = -((cam.x * cam.zoom) % s);
    const oy = -((cam.y * cam.zoom) % s);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.12)';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.06)';
    ctx.lineWidth = 1;
    if (kind === 'lines') {
      ctx.beginPath();
      for (let x = ox; x < width; x += s) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, height);
      }
      for (let y = oy; y < height; y += s) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(width, Math.round(y) + 0.5);
      }
      ctx.stroke();
      return;
    }
    const r = Math.max(0.8, Math.min(1.5, s / 20));
    for (let x = ox; x < width; x += s) {
      for (let y = oy; y < height; y += s) ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
  }

  drawItems(ctx: CanvasRenderingContext2D, items: DisplayItem[], lod: { text: boolean; shadows: boolean }): void {
    for (const item of items) {
      switch (item.kind) {
        case 'path': {
          const path = toPath2D(item);
          const alpha = ctx.globalAlpha;
          if (item.opacity !== undefined) ctx.globalAlpha = alpha * item.opacity;
          if (item.fill) {
            if (item.shadow && lod.shadows) {
              ctx.shadowColor = 'rgba(0,0,0,0.16)';
              ctx.shadowBlur = 8;
              ctx.shadowOffsetY = 2;
            }
            ctx.fillStyle = item.fill;
            ctx.fill(path);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;
          }
          if (item.stroke && item.width) {
            ctx.strokeStyle = item.stroke;
            ctx.lineWidth = item.width;
            ctx.lineCap = item.round ? 'round' : 'butt';
            ctx.lineJoin = item.round ? 'round' : 'miter';
            ctx.setLineDash(item.dash ?? []);
            ctx.stroke(path);
            ctx.setLineDash([]);
          }
          ctx.globalAlpha = alpha;
          break;
        }
        case 'text': {
          if (!lod.text) {
            ctx.fillStyle = 'rgba(31,41,55,0.25)';
            ctx.fillRect(item.x, item.y - item.font.size * 0.7, item.width, item.font.size * 0.6);
            break;
          }
          if (item.highlight) {
            ctx.fillStyle = item.highlight.color;
            ctx.fillRect(item.x, item.y - item.font.size * 0.95, item.width, item.font.size * 1.25);
          }
          ctx.font = cssFont(item.font);
          ctx.fillStyle = item.color;
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(item.text, item.x, item.y);
          if (item.underline || item.strike) {
            ctx.strokeStyle = item.color;
            ctx.lineWidth = Math.max(1, item.font.size / 14);
            ctx.beginPath();
            if (item.underline) {
              ctx.moveTo(item.x, item.y + item.font.size * 0.12);
              ctx.lineTo(item.x + item.width, item.y + item.font.size * 0.12);
            }
            if (item.strike) {
              ctx.moveTo(item.x, item.y - item.font.size * 0.3);
              ctx.lineTo(item.x + item.width, item.y - item.font.size * 0.3);
            }
            ctx.stroke();
          }
          break;
        }
        case 'image': {
          const img = this.imageFor(item.src);
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(item.x, item.y, item.w, item.h, item.radius ?? 0);
          ctx.clip();
          if (img) {
            if (item.crop) {
              ctx.drawImage(img, item.crop.x * img.naturalWidth, item.crop.y * img.naturalHeight, item.crop.w * img.naturalWidth, item.crop.h * img.naturalHeight, item.x, item.y, item.w, item.h);
            } else {
              // Cover the box, keeping proportions.
              const scale = Math.max(item.w / img.naturalWidth, item.h / img.naturalHeight);
              const w = img.naturalWidth * scale;
              const h = img.naturalHeight * scale;
              ctx.drawImage(img, item.x + (item.w - w) / 2, item.y + (item.h - h) / 2, w, h);
            }
          } else {
            ctx.fillStyle = '#eef0f3';
            ctx.fillRect(item.x, item.y, item.w, item.h);
          }
          ctx.restore();
          break;
        }
        case 'group': {
          ctx.save();
          if (item.opacity !== undefined) ctx.globalAlpha *= item.opacity;
          if (item.rotate) {
            ctx.translate(item.rotate.cx, item.rotate.cy);
            ctx.rotate(item.rotate.angle);
            ctx.translate(-item.rotate.cx, -item.rotate.cy);
          }
          this.drawItems(ctx, item.items, lod);
          ctx.restore();
          break;
        }
      }
    }
  }
}
