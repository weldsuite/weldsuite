/**
 * The view onto the infinite board: which board point sits at the top-left
 * of the screen and how far in we are zoomed. Screen coordinates are CSS
 * pixels relative to the canvas; board coordinates are board units.
 */

import type { Point, Rect } from '@weldsuite/board-engine';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 40;

export interface Camera {
  /** Board point at the canvas's top-left corner. */
  x: number;
  y: number;
  zoom: number;
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function toBoard(c: Camera, p: Point): Point {
  return { x: c.x + p.x / c.zoom, y: c.y + p.y / c.zoom };
}

export function toScreen(c: Camera, p: Point): Point {
  return { x: (p.x - c.x) * c.zoom, y: (p.y - c.y) * c.zoom };
}

/** Zooms to `zoom`, keeping the board point under `screen` where it is. */
export function zoomAt(c: Camera, zoom: number, screen: Point): Camera {
  const z = clampZoom(zoom);
  const anchor = toBoard(c, screen);
  return { x: anchor.x - screen.x / z, y: anchor.y - screen.y / z, zoom: z };
}

/** The part of the board a viewport of `width` × `height` px shows. */
export function visibleRect(c: Camera, width: number, height: number): Rect {
  return { x: c.x, y: c.y, w: width / c.zoom, h: height / c.zoom };
}

/** A camera showing `r` (with a margin) in a viewport, never zoomed past 100% unless asked. */
export function fitRect(r: Rect, width: number, height: number, options: { margin?: number; maxZoom?: number } = {}): Camera {
  const margin = options.margin ?? 64;
  const w = Math.max(1, r.w);
  const h = Math.max(1, r.h);
  const zoom = clampZoom(Math.min((width - margin * 2) / w, (height - margin * 2) / h, options.maxZoom ?? 1));
  return { x: r.x + w / 2 - width / 2 / zoom, y: r.y + h / 2 - height / 2 / zoom, zoom };
}

/** Zoom steps for the zoom buttons and Ctrl +/-. */
const STEPS = [0.02, 0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 40];

export function nextZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > zoom + 1e-6) ?? MAX_ZOOM;
  return [...STEPS].reverse().find((s) => s < zoom - 1e-6) ?? MIN_ZOOM;
}
