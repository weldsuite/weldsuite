/**
 * Snapping while moving or resizing: the moving box's edges and centre lock
 * onto other elements' edges and centres within a threshold, and the guides
 * to draw come back with the correction.
 */

import type { Rect } from './path';

export interface Guide {
  axis: 'x' | 'y';
  /** The coordinate of the guide line. */
  at: number;
  /** The extent of the line along the other axis. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

function lines(r: Rect, axis: 'x' | 'y'): number[] {
  return axis === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h];
}

function bestOffset(moving: number[], targets: number[], threshold: number): { offset: number; at: number } | null {
  let best: { offset: number; at: number } | null = null;
  for (const m of moving) {
    for (const t of targets) {
      const d = t - m;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.offset))) best = { offset: d, at: t };
    }
  }
  return best;
}

/**
 * Where `moving` should go to line up with `others`, within `threshold`
 * board units. `edges` limits which edges of the moving box snap (a resize
 * moves only the dragged sides).
 */
export function snapRect(
  moving: Rect,
  others: Rect[],
  threshold: number,
  edges: { x?: number[]; y?: number[] } = {},
): SnapResult {
  const mx = edges.x ?? lines(moving, 'x');
  const my = edges.y ?? lines(moving, 'y');
  const tx = others.flatMap((o) => lines(o, 'x'));
  const ty = others.flatMap((o) => lines(o, 'y'));
  const sx = bestOffset(mx, tx, threshold);
  const sy = bestOffset(my, ty, threshold);
  const dx = sx?.offset ?? 0;
  const dy = sy?.offset ?? 0;
  const snapped = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  const guides: Guide[] = [];
  if (sx) {
    const matches = others.filter((o) => lines(o, 'x').some((v) => Math.abs(v - sx.at) < 0.5));
    const ys = [snapped.y, snapped.y + snapped.h, ...matches.flatMap((o) => [o.y, o.y + o.h])];
    guides.push({ axis: 'x', at: sx.at, from: Math.min(...ys), to: Math.max(...ys) });
  }
  if (sy) {
    const matches = others.filter((o) => lines(o, 'y').some((v) => Math.abs(v - sy.at) < 0.5));
    const xs = [snapped.x, snapped.x + snapped.w, ...matches.flatMap((o) => [o.x, o.x + o.w])];
    guides.push({ axis: 'y', at: sy.at, from: Math.min(...xs), to: Math.max(...xs) });
  }
  return { dx, dy, guides };
}

/** Rounds to a grid of `size` board units. */
export function snapToGrid(v: number, size: number): number {
  return Math.round(v / size) * size;
}
