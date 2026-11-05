/**
 * Points, rectangles and vector paths: the geometry everything else is
 * built from. Paths are lists of commands in absolute coordinates, drawn the
 * same way by the canvas, the SVG writer and the PDF writer.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PathCmd =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Q', number, number, number, number]
  | ['Z'];

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

/** A rectangle with positive size from any two corners. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function rectContainsPoint(r: Rect, p: Point, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

export function unionRects(rects: Rect[]): Rect | null {
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

export function boundsOfPoints(points: Point[]): Rect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

export function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function rotatePoint(p: Point, around: Point, angle: number): Point {
  if (!angle) return p;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - around.x;
  const dy = p.y - around.y;
  return { x: around.x + dx * cos - dy * sin, y: around.y + dx * sin + dy * cos };
}

/** Distance from `p` to the segment a→b. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToPolyline(p: Point, points: Point[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return distance(p, points[0]!);
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) best = Math.min(best, distanceToSegment(p, points[i]!, points[i + 1]!));
  return best;
}

export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function quadAt(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** The path as polylines (one per subpath), curves sampled into `steps` segments. */
export function flattenPath(cmds: PathCmd[], steps = 16): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  let start: Point = { x: 0, y: 0 };
  let last: Point = { x: 0, y: 0 };
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        if (current.length) out.push(current);
        last = start = { x: c[1], y: c[2] };
        current = [last];
        break;
      case 'L':
        last = { x: c[1], y: c[2] };
        current.push(last);
        break;
      case 'C': {
        const p0 = last;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          current.push({ x: cubicAt(p0.x, c[1], c[3], c[5], t), y: cubicAt(p0.y, c[2], c[4], c[6], t) });
        }
        last = { x: c[5], y: c[6] };
        break;
      }
      case 'Q': {
        const p0 = last;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          current.push({ x: quadAt(p0.x, c[1], c[3], t), y: quadAt(p0.y, c[2], c[4], t) });
        }
        last = { x: c[3], y: c[4] };
        break;
      }
      case 'Z':
        current.push(start);
        last = start;
        break;
    }
  }
  if (current.length) out.push(current);
  return out;
}

/** Moves and rotates a path: local coordinates in a box at (x, y), rotated around the box centre. */
export function placePath(cmds: PathCmd[], x: number, y: number, w: number, h: number, rotation = 0): PathCmd[] {
  const c = { x: x + w / 2, y: y + h / 2 };
  const map = (px: number, py: number): [number, number] => {
    const p = rotatePoint({ x: x + px, y: y + py }, c, rotation);
    return [p.x, p.y];
  };
  return cmds.map((cmd): PathCmd => {
    switch (cmd[0]) {
      case 'M':
        return ['M', ...map(cmd[1], cmd[2])];
      case 'L':
        return ['L', ...map(cmd[1], cmd[2])];
      case 'C':
        return ['C', ...map(cmd[1], cmd[2]), ...map(cmd[3], cmd[4]), ...map(cmd[5], cmd[6])];
      case 'Q':
        return ['Q', ...map(cmd[1], cmd[2]), ...map(cmd[3], cmd[4])];
      case 'Z':
        return ['Z'];
    }
  });
}

/** An ellipse inscribed in a box, as four cubic curves. */
export function ellipsePath(x: number, y: number, w: number, h: number): PathCmd[] {
  const k = 0.5522847498;
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry],
    ['C', cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy],
    ['C', cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry],
    ['C', cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy],
    ['Z'],
  ];
}

/** A rectangle with rounded corners (radius clamped to half the shorter side). */
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): PathCmd[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  const k = rr * 0.4477152502;
  return [
    ['M', x + rr, y],
    ['L', x + w - rr, y],
    ['C', x + w - k, y, x + w, y + k, x + w, y + rr],
    ['L', x + w, y + h - rr],
    ['C', x + w, y + h - k, x + w - k, y + h, x + w - rr, y + h],
    ['L', x + rr, y + h],
    ['C', x + k, y + h, x, y + h - k, x, y + h - rr],
    ['L', x, y + rr],
    ['C', x, y + k, x + k, y, x + rr, y],
    ['Z'],
  ];
}

export function polygonPath(points: [number, number][]): PathCmd[] {
  if (points.length === 0) return [];
  const [first, ...rest] = points;
  return [['M', first![0], first![1]], ...rest.map(([px, py]): PathCmd => ['L', px, py]), ['Z']];
}

/** A polyline through points, smoothed into curves through the midpoints (pen strokes). */
export function smoothPath(points: Point[]): PathCmd[] {
  if (points.length === 0) return [];
  if (points.length < 3) return [['M', points[0]!.x, points[0]!.y], ...points.slice(1).map((p): PathCmd => ['L', p.x, p.y])];
  const cmds: PathCmd[] = [['M', points[0]!.x, points[0]!.y]];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const n = points[i + 1]!;
    cmds.push(['Q', p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2]);
  }
  const last = points[points.length - 1]!;
  cmds.push(['L', last.x, last.y]);
  return cmds;
}

/** The SVG `d` attribute of a path. */
export function pathToSvg(cmds: PathCmd[], digits = 2): string {
  const f = (n: number) => {
    const s = n.toFixed(digits);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  };
  return cmds.map((c) => (c[0] === 'Z' ? 'Z' : c[0] + (c.slice(1) as number[]).map(f).join(' '))).join('');
}
