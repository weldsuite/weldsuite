/**
 * Geometry of the designer canvas: resizing, snapping to a grid, magnetic
 * alignment guides and marquee hit-testing. Pure functions in PDF points, so
 * they can be tested without a DOM.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const GRID = 4;
export const MIN_SIZE = 4;
/** Left and right margin the guides offer (the presets use it too); top and bottom come from the template. */
export const SIDE_MARGIN = 48;

/** A guide line shown while dragging: a vertical (`x`) or horizontal (`y`) segment at `pos`. */
export interface Guide {
  axis: 'x' | 'y';
  pos: number;
  start: number;
  end: number;
}

export interface SnapContext {
  page: { width: number; height: number };
  margins: { top: number; bottom: number };
  /** Rectangles of the blocks that are not being moved. */
  others: Rect[];
  /** Snap distance in points (screen pixels divided by the scale). */
  threshold: number;
  grid?: number;
  /** Alt held: no snapping at all. */
  disabled?: boolean;
}

interface Target {
  pos: number;
  /** The extent along the other axis the guide spans. */
  from: number;
  to: number;
}

const EPS = 0.01;

export const round2 = (n: number) => Math.round(n * 100) / 100;

function xTargets(ctx: SnapContext): Target[] {
  const { width, height } = ctx.page;
  const out: Target[] = [];
  for (const pos of [0, SIDE_MARGIN, width / 2, width - SIDE_MARGIN, width]) out.push({ pos, from: 0, to: height });
  for (const o of ctx.others) {
    for (const pos of [o.x, o.x + o.w / 2, o.x + o.w]) out.push({ pos, from: o.y, to: o.y + o.h });
  }
  return out;
}

function yTargets(ctx: SnapContext): Target[] {
  const { width, height } = ctx.page;
  const out: Target[] = [];
  for (const pos of [0, ctx.margins.top, height / 2, height - ctx.margins.bottom, height]) out.push({ pos, from: 0, to: width });
  for (const o of ctx.others) {
    for (const pos of [o.y, o.y + o.h / 2, o.y + o.h]) out.push({ pos, from: o.x, to: o.x + o.w });
  }
  return out;
}

function targetsFor(axis: 'x' | 'y', ctx: SnapContext): Target[] {
  return axis === 'x' ? xTargets(ctx) : yTargets(ctx);
}

/** The smallest signed distance from any candidate to any target, when within the threshold. */
function bestOffset(candidates: number[], targets: Target[], threshold: number): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    for (const t of targets) {
      const d = t.pos - c;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best) - EPS)) best = d;
    }
  }
  return best;
}

const snapToGrid = (value: number, grid: number) => Math.round(value / grid) * grid;

/** Guide segments for every candidate that lines up with a target. */
function guidesFor(axis: 'x' | 'y', candidates: number[], rect: Rect, targets: Target[]): Guide[] {
  const guides = new Map<number, Guide>();
  const lo = axis === 'x' ? rect.y : rect.x;
  const hi = axis === 'x' ? rect.y + rect.h : rect.x + rect.w;
  for (const c of candidates) {
    for (const t of targets) {
      if (Math.abs(t.pos - c) > EPS) continue;
      const key = round2(t.pos);
      const start = Math.min(lo, t.from);
      const end = Math.max(hi, t.to);
      const existing = guides.get(key);
      if (existing) {
        existing.start = Math.min(existing.start, start);
        existing.end = Math.max(existing.end, end);
      } else {
        guides.set(key, { axis, pos: key, start, end });
      }
    }
  }
  return [...guides.values()];
}

const xCandidates = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
const yCandidates = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];

/**
 * Snaps a rectangle being moved. Edges and centres snap magnetically to the
 * page edges, centre and margins and to the other blocks; with nothing near,
 * the top-left corner snaps to the grid.
 */
export function snapMove(rect: Rect, ctx: SnapContext): { rect: Rect; guides: Guide[] } {
  if (ctx.disabled) return { rect, guides: [] };
  const grid = ctx.grid ?? GRID;
  const tx = targetsFor('x', ctx);
  const ty = targetsFor('y', ctx);
  const dx = bestOffset(xCandidates(rect), tx, ctx.threshold);
  const dy = bestOffset(yCandidates(rect), ty, ctx.threshold);
  const next: Rect = {
    ...rect,
    x: dx === null ? snapToGrid(rect.x, grid) : rect.x + dx,
    y: dy === null ? snapToGrid(rect.y, grid) : rect.y + dy,
  };
  const guides = [
    ...(dx === null ? [] : guidesFor('x', xCandidates(next), next, tx)),
    ...(dy === null ? [] : guidesFor('y', yCandidates(next), next, ty)),
  ];
  return { rect: next, guides };
}

/** Proportional corner resize: the corner follows whichever axis moved more. */
function resizeProportional(start: Rect, handle: ResizeHandle, dx: number, dy: number, minW: number, minH: number): Rect {
  const west = handle.includes('w');
  const north = handle.includes('n');
  const ratio = start.w / start.h;
  const nw = Math.max(minW, west ? start.w - dx : start.w + dx);
  const nh = Math.max(minH, north ? start.h - dy : start.h + dy);
  const scale = Math.max(nw / start.w, nh / start.h);
  const w = Math.max(minW, start.w * scale);
  const h = Math.max(minH, w / ratio);
  return {
    x: west ? start.x + start.w - w : start.x,
    y: north ? start.y + start.h - h : start.y,
    w,
    h,
  };
}

/** Resizes from a start rectangle by a pointer delta, keeping at least the minimum size. */
export function resizeRect(
  start: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  opts: { minW?: number; minH?: number; aspect?: boolean } = {},
): Rect {
  const minW = opts.minW ?? MIN_SIZE;
  const minH = opts.minH ?? MIN_SIZE;
  let { x, y, w, h } = start;
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');

  if (opts.aspect && handle.length === 2 && start.w > 0 && start.h > 0) {
    return resizeProportional(start, handle, dx, dy, minW, minH);
  }

  if (east) w = start.w + dx;
  if (west) {
    x = start.x + dx;
    w = start.w - dx;
  }
  if (south) h = start.h + dy;
  if (north) {
    y = start.y + dy;
    h = start.h - dy;
  }
  if (w < minW) {
    if (west) x = start.x + start.w - minW;
    w = minW;
  }
  if (h < minH) {
    if (north) y = start.y + start.h - minH;
    h = minH;
  }
  return { x, y, w, h };
}

/** Snaps the edges a resize handle is dragging (to guides, else to the grid). */
export function snapResize(
  rect: Rect,
  handle: ResizeHandle,
  ctx: SnapContext,
  opts: { minW?: number; minH?: number } = {},
): { rect: Rect; guides: Guide[] } {
  if (ctx.disabled) return { rect, guides: [] };
  const grid = ctx.grid ?? GRID;
  const minW = opts.minW ?? MIN_SIZE;
  const minH = opts.minH ?? MIN_SIZE;
  const tx = targetsFor('x', ctx);
  const ty = targetsFor('y', ctx);
  let { x, y, w, h } = rect;
  const guides: Guide[] = [];

  const snapEdge = (edge: number, targets: Target[]) => {
    const d = bestOffset([edge], targets, ctx.threshold);
    return d === null ? { value: snapToGrid(edge, grid), snapped: false } : { value: edge + d, snapped: true };
  };

  if (handle.includes('w')) {
    const right = x + w;
    const s = snapEdge(x, tx);
    x = Math.min(s.value, right - minW);
    w = right - x;
    if (s.snapped) guides.push(...guidesFor('x', [x], { x, y, w, h }, tx));
  } else if (handle.includes('e')) {
    const s = snapEdge(x + w, tx);
    w = Math.max(minW, s.value - x);
    if (s.snapped) guides.push(...guidesFor('x', [x + w], { x, y, w, h }, tx));
  }
  if (handle.includes('n')) {
    const bottom = y + h;
    const s = snapEdge(y, ty);
    y = Math.min(s.value, bottom - minH);
    h = bottom - y;
    if (s.snapped) guides.push(...guidesFor('y', [y], { x, y, w, h }, ty));
  } else if (handle.includes('s')) {
    const s = snapEdge(y + h, ty);
    h = Math.max(minH, s.value - y);
    if (s.snapped) guides.push(...guidesFor('y', [y + h], { x, y, w, h }, ty));
  }
  return { rect: { x, y, w, h }, guides };
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Rectangle between two corner points (a marquee drag), whatever the drag direction. */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Ids of the blocks a marquee touches. */
export function idsInMarquee(blocks: ReadonlyArray<{ id: string } & Rect>, marquee: Rect): string[] {
  return blocks.filter((b) => rectsIntersect(b, marquee)).map((b) => b.id);
}
