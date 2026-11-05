/**
 * Bounds and hit-testing of elements. Everything is in board units; the
 * caller passes a tolerance already divided by the zoom, so a line stays
 * easy to hit at any zoom level.
 */

import type { Board } from '../model/board';
import type { BoardElement } from '../model/types';
import { connectorGeometry, elementBox } from './connectors';
import {
  boundsOfPoints,
  center,
  distanceToPolyline,
  flattenPath,
  pointInPolygon,
  rectContainsPoint,
  rotatePoint,
  type Point,
  type Rect,
} from './path';
import { shapeOutline } from './shapes';

/** Pen points as absolute points. */
export function penPoints(el: BoardElement): Point[] {
  const pts = el.points ?? [];
  const out: Point[] = [];
  for (let i = 0; i + 1 < pts.length; i += 3) out.push({ x: el.x + pts[i]!, y: el.y + pts[i + 1]! });
  return out;
}

/** The four corners of an element's (rotated) box. */
export function corners(el: BoardElement): Point[] {
  const box = elementBox(el);
  const c = center(box);
  const r = el.rotation ?? 0;
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((p) => rotatePoint(p, c, r));
}

/** Axis-aligned bounds, rotation and connector routes included. */
export function elementBounds(board: Board, el: BoardElement): Rect {
  if (el.type === 'connector') {
    const g = connectorGeometry(board, el);
    return boundsOfPoints(g.points) ?? { x: el.x, y: el.y, w: 0, h: 0 };
  }
  if (el.type === 'pen') {
    const b = boundsOfPoints(penPoints(el));
    const pad = (el.strokeWidth ?? 2) / 2;
    return b ? { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 } : elementBox(el);
  }
  if (!el.rotation) return elementBox(el);
  return boundsOfPoints(corners(el))!;
}

/** Bounds of many elements, or null when there are none. */
export function selectionBounds(board: Board, ids: Iterable<string>): Rect | null {
  const rects: Rect[] = [];
  for (const id of ids) {
    const el = board.get(id);
    if (el) rects.push(elementBounds(board, el));
  }
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** `p` in the element's local, unrotated frame. */
function toLocal(el: BoardElement, p: Point): Point {
  if (!el.rotation) return p;
  return rotatePoint(p, center(elementBox(el)), -el.rotation);
}

/** Frames are hit on their title and their border, so you can draw and select inside them. */
const FRAME_TITLE = 28;

export function hitElement(board: Board, el: BoardElement, p: Point, tolerance: number): boolean {
  switch (el.type) {
    case 'connector': {
      const g = connectorGeometry(board, el);
      return distanceToPolyline(p, g.points) <= tolerance + (el.strokeWidth ?? 2) / 2;
    }
    case 'pen':
      return distanceToPolyline(p, penPoints(el)) <= tolerance + (el.strokeWidth ?? 2) / 2;
    case 'frame': {
      const local = toLocal(el, p);
      const box = elementBox(el);
      const title = { x: box.x, y: box.y - FRAME_TITLE, w: Math.max(box.w * 0.6, 80), h: FRAME_TITLE };
      if (rectContainsPoint(title, local)) return true;
      if (!rectContainsPoint(box, local, tolerance)) return false;
      const inner = { x: box.x + tolerance, y: box.y + tolerance, w: box.w - tolerance * 2, h: box.h - tolerance * 2 };
      return !rectContainsPoint(inner, local);
    }
    case 'group':
      return false;
    case 'shape': {
      const local = toLocal(el, p);
      if (!rectContainsPoint(elementBox(el), local, tolerance)) return false;
      const outline = flattenPath(shapeOutline(el.shape ?? 'rectangle', el.w, el.h, el.radius ?? 0), 12);
      const lp = { x: local.x - el.x, y: local.y - el.y };
      const hasFill = el.fill !== undefined && el.fill !== 'transparent';
      // An unfilled shape is hit on its outline and on its text, not through its middle.
      if (hasFill || el.text?.text) return outline.some((poly) => pointInPolygon(lp, poly)) || outline.some((poly) => distanceToPolyline(lp, poly) <= tolerance);
      return outline.some((poly) => distanceToPolyline(lp, poly) <= tolerance + (el.strokeWidth ?? 2));
    }
    default:
      return rectContainsPoint(elementBox(el), toLocal(el, p), tolerance);
  }
}

/** Whether an element touches (or, with `contain`, lies inside) a marquee rectangle. */
export function elementInRect(board: Board, el: BoardElement, r: Rect, contain: boolean): boolean {
  const b = elementBounds(board, el);
  if (contain) return b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
  if (b.x > r.x + r.w || b.x + b.w < r.x || b.y > r.y + r.h || b.y + b.h < r.y) return false;
  if (el.type === 'pen') return penPoints(el).some((q) => rectContainsPoint(r, q)) || containsAny(r, b);
  if (el.type === 'connector') return connectorGeometry(board, el).points.some((q) => rectContainsPoint(r, q)) || containsAny(r, b);
  return true;
}

function containsAny(r: Rect, b: Rect): boolean {
  return b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
}
