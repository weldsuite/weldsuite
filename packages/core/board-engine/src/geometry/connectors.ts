/**
 * Connectors: where their ends are (following the elements they are bound
 * to), and the route between them: straight, elbow (orthogonal, around the
 * two connected shapes) or curved.
 *
 * Routes are computed from the board on every draw; nothing about a route
 * is stored except an optional curve control point, so moving a shape moves
 * every connector bound to it without any op on the connector.
 */

import type { Board } from '../model/board';
import type { BoardElement, Cap, ConnectorEnd, Side } from '../model/types';
import { center, distance, inflate, rotatePoint, type PathCmd, type Point, type Rect } from './path';

export interface ResolvedEnd {
  p: Point;
  /** Outward direction at a bound end (unit vector), null when free. */
  dir: Point | null;
  /** Box of the element it is bound to. */
  box: Rect | null;
}

export interface ConnectorGeometry {
  cmds: PathCmd[];
  /** The route as a polyline (curves sampled), for hit-testing, bounds and labels. */
  points: Point[];
  start: ResolvedEnd;
  end: ResolvedEnd;
  /** Angle (radians) the line arrives at each end with, pointing out of the line. */
  startAngle: number;
  endAngle: number;
  label: Point;
}

const MARGIN = 24;
const SIDE_DIRS: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export function elementBox(el: BoardElement): Rect {
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

/** A side's midpoint of an element's box (rotated with it). */
export function sidePoint(el: BoardElement, side: Side): Point {
  const box = elementBox(el);
  const c = center(box);
  const local: Record<Side, Point> = {
    top: { x: c.x, y: box.y },
    right: { x: box.x + box.w, y: c.y },
    bottom: { x: c.x, y: box.y + box.h },
    left: { x: box.x, y: c.y },
  };
  return rotatePoint(local[side], c, el.rotation ?? 0);
}

function rotateDir(d: Point, angle: number): Point {
  if (!angle) return d;
  return rotatePoint(d, { x: 0, y: 0 }, angle);
}

/** The side of `el` that faces `toward` best. */
export function facingSide(el: BoardElement, toward: Point): Side {
  const c = center(elementBox(el));
  const local = rotatePoint(toward, c, -(el.rotation ?? 0));
  const dx = (local.x - c.x) / Math.max(el.w, 1);
  const dy = (local.y - c.y) / Math.max(el.h, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

function boundElement(board: Board, end: ConnectorEnd | undefined): BoardElement | null {
  if (!end?.el) return null;
  const el = board.get(end.el);
  return el && el.type !== 'connector' ? el : null;
}

/** Resolves one end. `other` is roughly where the other end is (for an `auto` side). */
export function resolveEnd(board: Board, end: ConnectorEnd | undefined, other: Point): ResolvedEnd {
  const fallback = { p: { x: end?.x ?? 0, y: end?.y ?? 0 }, dir: null, box: null };
  if (!end) return fallback;
  const el = boundElement(board, end);
  if (!el) return fallback;
  const box = elementBox(el);
  if (end.rx !== undefined && end.ry !== undefined) {
    const c = center(box);
    const p = rotatePoint({ x: box.x + end.rx * box.w, y: box.y + end.ry * box.h }, c, el.rotation ?? 0);
    return { p, dir: null, box };
  }
  const side = !end.side || end.side === 'auto' ? facingSide(el, other) : end.side;
  return { p: sidePoint(el, side), dir: rotateDir(SIDE_DIRS[side], el.rotation ?? 0), box };
}

/** Roughly where an end is, without resolving sides (the element's centre when bound). */
function roughEnd(board: Board, end: ConnectorEnd | undefined): Point {
  if (!end) return { x: 0, y: 0 };
  const el = boundElement(board, end);
  return el ? center(elementBox(el)) : { x: end.x, y: end.y };
}

export function connectorGeometry(board: Board, el: BoardElement): ConnectorGeometry {
  const roughStart = roughEnd(board, el.start);
  const roughEndPoint = roughEnd(board, el.end);
  const start = resolveEnd(board, el.start, roughEndPoint);
  const end = resolveEnd(board, el.end, roughStart);
  const route = el.route ?? 'straight';
  let points: Point[];
  let cmds: PathCmd[];
  if (route === 'elbow') {
    points = elbowRoute(start, end);
    cmds = polylineCmds(points);
  } else if (route === 'curved') {
    const curve = curvedRoute(start, end, el.control ?? null);
    cmds = curve.cmds;
    points = curve.points;
  } else {
    points = [start.p, end.p];
    cmds = polylineCmds(points);
  }
  const a = points[0]!;
  const a2 = points.find((p) => distance(p, a) > 0.5) ?? end.p;
  const b = points[points.length - 1]!;
  const b2 = [...points].reverse().find((p) => distance(p, b) > 0.5) ?? start.p;
  return {
    cmds,
    points,
    start,
    end,
    startAngle: Math.atan2(a.y - a2.y, a.x - a2.x),
    endAngle: Math.atan2(b.y - b2.y, b.x - b2.x),
    label: pointAlong(points, el.labelAt ?? 0.5),
  };
}

function polylineCmds(points: Point[]): PathCmd[] {
  if (points.length === 0) return [];
  return [['M', points[0]!.x, points[0]!.y], ...points.slice(1).map((p): PathCmd => ['L', p.x, p.y])];
}

/** The point `t` (0–1) of the way along a polyline. */
export function pointAlong(points: Point[], t: number): Point {
  if (points.length === 1) return points[0]!;
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1]!, points[i]!);
  let target = total * Math.max(0, Math.min(1, t));
  for (let i = 1; i < points.length; i++) {
    const seg = distance(points[i - 1]!, points[i]!);
    if (target <= seg || i === points.length - 1) {
      const f = seg === 0 ? 0 : Math.min(1, target / seg);
      const a = points[i - 1]!;
      const b = points[i]!;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    target -= seg;
  }
  return points[points.length - 1]!;
}

/** Where along a polyline (0–1) the closest point to `p` is. */
export function nearestAlong(points: Point[], p: Point): number {
  let total = 0;
  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const l = distance(points[i - 1]!, points[i]!);
    lengths.push(l);
    total += l;
  }
  if (total === 0) return 0.5;
  let best = Infinity;
  let bestAt = 0;
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const l = lengths[i - 1]!;
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l)));
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d = distance(p, q);
    if (d < best) {
      best = d;
      bestAt = (run + t * l) / total;
    }
    run += l;
  }
  return bestAt;
}

function curvedRoute(start: ResolvedEnd, end: ResolvedEnd, control: Point | null): { cmds: PathCmd[]; points: Point[] } {
  const s = start.p;
  const e = end.p;
  if (control) {
    // A quadratic that passes through the control point halfway.
    const q = { x: 2 * control.x - (s.x + e.x) / 2, y: 2 * control.y - (s.y + e.y) / 2 };
    const cmds: PathCmd[] = [['M', s.x, s.y], ['Q', q.x, q.y, e.x, e.y]];
    return { cmds, points: sampleQuad(s, q, e) };
  }
  const k = Math.max(40, distance(s, e) / 3);
  const toward = (from: Point, to: Point): Point => {
    const d = distance(from, to) || 1;
    return { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
  };
  const ds = start.dir ?? toward(s, e);
  const de = end.dir ?? toward(e, s);
  const c1 = { x: s.x + ds.x * k, y: s.y + ds.y * k };
  const c2 = { x: e.x + de.x * k, y: e.y + de.y * k };
  const cmds: PathCmd[] = [['M', s.x, s.y], ['C', c1.x, c1.y, c2.x, c2.y, e.x, e.y]];
  return { cmds, points: sampleCubic(s, c1, c2, e) };
}

function sampleQuad(a: Point, q: Point, b: Point, steps = 24): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * q.x + t * t * b.x, y: u * u * a.y + 2 * u * t * q.y + t * t * b.y });
  }
  return out;
}

function sampleCubic(a: Point, c1: Point, c2: Point, b: Point, steps = 24): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elbow routing
// ---------------------------------------------------------------------------

/** Snaps a direction to the nearest axis (rotated shapes still route orthogonally). */
function axisDir(d: Point | null): Point | null {
  if (!d) return null;
  return Math.abs(d.x) >= Math.abs(d.y) ? { x: Math.sign(d.x) || 1, y: 0 } : { x: 0, y: Math.sign(d.y) || 1 };
}

function insideStrict(p: Point, r: Rect): boolean {
  return p.x > r.x + 0.01 && p.x < r.x + r.w - 0.01 && p.y > r.y + 0.01 && p.y < r.y + r.h - 0.01;
}

function segmentCrosses(a: Point, b: Point, r: Rect): boolean {
  // Axis-aligned segments only.
  if (a.x === b.x) {
    if (a.x <= r.x + 0.01 || a.x >= r.x + r.w - 0.01) return false;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return hi > r.y + 0.01 && lo < r.y + r.h - 0.01;
  }
  if (a.y <= r.y + 0.01 || a.y >= r.y + r.h - 0.01) return false;
  const lo = Math.min(a.x, b.x);
  const hi = Math.max(a.x, b.x);
  return hi > r.x + 0.01 && lo < r.x + r.w - 0.01;
}

/**
 * An orthogonal route from start to end that leaves and enters along the
 * sides' directions and goes around both connected shapes: A* over a sparse
 * grid made of the interesting x and y coordinates, with a cost per bend so
 * the route prefers fewer turns.
 */
export function elbowRoute(start: ResolvedEnd, end: ResolvedEnd): Point[] {
  const ds = axisDir(start.dir);
  const de = axisDir(end.dir);
  const s0 = start.p;
  const e0 = end.p;
  const s1 = ds ? { x: s0.x + ds.x * MARGIN, y: s0.y + ds.y * MARGIN } : s0;
  const e1 = de ? { x: e0.x + de.x * MARGIN, y: e0.y + de.y * MARGIN } : e0;
  const obstacles = [start.box, end.box].filter((b): b is Rect => b !== null).map((b) => inflate(b, MARGIN - 1));

  const xs = new Set<number>([s1.x, e1.x, (s1.x + e1.x) / 2]);
  const ys = new Set<number>([s1.y, e1.y, (s1.y + e1.y) / 2]);
  for (const o of obstacles) {
    xs.add(o.x - 1);
    xs.add(o.x + o.w + 1);
    ys.add(o.y - 1);
    ys.add(o.y + o.h + 1);
  }
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  const key = (i: number, j: number) => i * Y.length + j;
  const blocked = (p: Point) => obstacles.some((o) => insideStrict(p, o));

  const si = X.indexOf(s1.x);
  const sj = Y.indexOf(s1.y);
  const ei = X.indexOf(e1.x);
  const ej = Y.indexOf(e1.y);
  const path = astar(X, Y, si, sj, ei, ej, key, blocked, obstacles, ds);
  const middle = path ?? fallbackElbow(s1, e1, ds);
  return simplify([s0, ...middle, e0]);
}

interface Node {
  i: number;
  j: number;
  /** Direction of travel into this node: 0 none, 1 horizontal, 2 vertical. */
  d: 0 | 1 | 2;
  g: number;
  f: number;
  prev: Node | null;
}

function astar(
  X: number[],
  Y: number[],
  si: number,
  sj: number,
  ei: number,
  ej: number,
  key: (i: number, j: number) => number,
  blocked: (p: Point) => boolean,
  obstacles: Rect[],
  ds: Point | null,
): Point[] | null {
  const BEND = 40;
  const at = (i: number, j: number): Point => ({ x: X[i]!, y: Y[j]! });
  const h = (i: number, j: number) => Math.abs(X[i]! - X[ei]!) + Math.abs(Y[j]! - Y[ej]!);
  const startDir: 0 | 1 | 2 = ds ? (ds.x !== 0 ? 1 : 2) : 0;
  const open: Node[] = [{ i: si, j: sj, d: startDir, g: 0, f: h(si, sj), prev: null }];
  const best = new Map<string, number>();
  for (let guard = 0; open.length && guard < 20_000; guard++) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k]!.f < open[bi]!.f) bi = k;
    const node = open.splice(bi, 1)[0]!;
    if (node.i === ei && node.j === ej) {
      const out: Point[] = [];
      for (let n: Node | null = node; n; n = n.prev) out.push(at(n.i, n.j));
      return out.reverse();
    }
    const steps: [number, number, 1 | 2][] = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 2],
      [0, -1, 2],
    ];
    for (const [di, dj, dir] of steps) {
      const ni = node.i + di;
      const nj = node.j + dj;
      if (ni < 0 || nj < 0 || ni >= X.length || nj >= Y.length) continue;
      const a = at(node.i, node.j);
      const b = at(ni, nj);
      if (blocked(b) || obstacles.some((o) => segmentCrosses(a, b, o))) continue;
      const g = node.g + Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + (node.d !== 0 && node.d !== dir ? BEND : 0);
      const k = `${key(ni, nj)}:${dir}`;
      if ((best.get(k) ?? Infinity) <= g) continue;
      best.set(k, g);
      open.push({ i: ni, j: nj, d: dir, g, f: g + h(ni, nj), prev: node });
    }
  }
  return null;
}

function fallbackElbow(s: Point, e: Point, ds: Point | null): Point[] {
  if (ds && ds.y !== 0) return [s, { x: s.x, y: e.y }, e];
  return [s, { x: e.x, y: s.y }, e];
}

/** Drops repeated and collinear points. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3) as [Point, Point, Point];
      const collinear = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
      if (!collinear) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** The outline of a line-end cap at `p`, pointing along `angle`. `filled` says whether to fill it. */
export function capPath(cap: Cap, p: Point, angle: number, strokeWidth: number): { cmds: PathCmd[]; filled: boolean } | null {
  if (cap === 'none') return null;
  const size = Math.max(10, strokeWidth * 4);
  const pt = (dx: number, dy: number): [number, number] => {
    const r = rotatePoint({ x: p.x + dx, y: p.y + dy }, p, angle);
    return [r.x, r.y];
  };
  switch (cap) {
    case 'arrow':
      return { cmds: [['M', ...pt(-size, -size * 0.55)], ['L', p.x, p.y], ['L', ...pt(-size, size * 0.55)]], filled: false };
    case 'triangle':
      return { cmds: [['M', p.x, p.y], ['L', ...pt(-size, -size * 0.55)], ['L', ...pt(-size, size * 0.55)], ['Z']], filled: true };
    case 'diamond':
      return {
        cmds: [['M', p.x, p.y], ['L', ...pt(-size * 0.6, -size * 0.45)], ['L', ...pt(-size * 1.2, 0)], ['L', ...pt(-size * 0.6, size * 0.45)], ['Z']],
        filled: true,
      };
    case 'circle': {
      const r = size * 0.35;
      const c = pt(-r, 0);
      const k = 0.5522847498 * r;
      return {
        cmds: [
          ['M', c[0] + r, c[1]],
          ['C', c[0] + r, c[1] + k, c[0] + k, c[1] + r, c[0], c[1] + r],
          ['C', c[0] - k, c[1] + r, c[0] - r, c[1] + k, c[0] - r, c[1]],
          ['C', c[0] - r, c[1] - k, c[0] - k, c[1] - r, c[0], c[1] - r],
          ['C', c[0] + k, c[1] - r, c[0] + r, c[1] - k, c[0] + r, c[1]],
          ['Z'],
        ],
        filled: true,
      };
    }
    case 'bar':
      return { cmds: [['M', ...pt(0, -size * 0.5)], ['L', ...pt(0, size * 0.5)]], filled: false };
  }
}
