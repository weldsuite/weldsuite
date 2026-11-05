/**
 * WeldFlow's old whiteboard format (`project_whiteboards.elements`): the
 * converter that turns a project whiteboard into a board on first open, and
 * the adapter behind the deprecated `/api/whiteboards` and `/v1/whiteboards`
 * shape (board → legacy elements, and a legacy `elements[]` write → ops).
 *
 * The old format:
 * - rectangle / sticky: (x, y) top-left, `width` × `height`, `color` fill, `strokeColor`, `borderRadius`
 * - circle: (x, y) centre, `radiusX` / `radiusY` (or one `radius`)
 * - text: (x, y) is the anchor on the baseline (left, centre or right by `textAlign`)
 * - path: absolute `points`, with `erasedPaths` masking parts of the stroke
 * - arrow: (x, y) → (endX, endY), `arrowType` line | arrow | elbow, optional bindings
 *   to elements by connection point, and a cubic curve whose two control
 *   points are both (curveControlX, curveControlY)
 */

import type { Board } from '../model/board';
import { DEFAULT_STROKE, STICKY_COLORS } from '../model/defaults';
import { keysBetween } from '../model/order';
import { isId } from '../model/schema';
import { plain } from '../model/text';
import type { BoardElement, BoardSnapshot, ConnectorEnd, ConnectorRoute, MarkRun, Marks, Side, TextAlign } from '../model/types';
import { SNAPSHOT_VERSION } from '../model/types';
import { connectorGeometry } from '../geometry/connectors';
import { batch, type Op } from '../ops/types';

export interface LegacyPoint {
  x: number;
  y: number;
}

export interface LegacyElement {
  id: string;
  type: 'rectangle' | 'circle' | 'text' | 'sticky' | 'path' | 'arrow';
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  radiusX?: number;
  radiusY?: number;
  text?: string;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  points?: LegacyPoint[];
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline';
  textAlign?: 'left' | 'center' | 'right';
  link?: string;
  locked?: boolean;
  endX?: number;
  endY?: number;
  erasedPaths?: { points: LegacyPoint[]; size: number }[];
  arrowType?: 'line' | 'arrow' | 'elbow';
  startElementId?: string;
  startConnectionPoint?: Side;
  endElementId?: string;
  endConnectionPoint?: Side;
  curveControlX?: number;
  curveControlY?: number;
  borderRadius?: number;
}

function n(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function colorOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^[#a-zA-Z0-9(),.\s%-]{1,64}$/.test(v) ? v : fallback;
}

const SIDES: readonly string[] = ['top', 'right', 'bottom', 'left'];

function textWidth(text: string, fontSize: number): number {
  const longest = Math.max(1, ...text.split('\n').map((l) => l.length));
  return Math.max(40, longest * fontSize * 0.6 + 8);
}

function wholeMarks(text: string, marks: Marks): MarkRun[] {
  return text.length && Object.keys(marks).length ? [[text.length, marks]] : [];
}

function safeUrl(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 2048 && /^(https?:|mailto:|\/)/i.test(v) ? v : undefined;
}

/** Splits a stroke where an eraser passed over it. */
function eraseStroke(points: LegacyPoint[], erased: { points: LegacyPoint[]; size: number }[]): LegacyPoint[][] {
  if (!erased.length) return [points];
  const hit = (p: LegacyPoint) =>
    erased.some((e) => {
      const r = Math.max(1, e.size) / 2;
      for (let i = 0; i < e.points.length; i++) {
        const a = e.points[i]!;
        const b = e.points[i + 1] ?? a;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= r) return true;
      }
      return false;
    });
  const out: LegacyPoint[][] = [];
  let current: LegacyPoint[] = [];
  for (const p of points) {
    if (hit(p)) {
      if (current.length > 1) out.push(current);
      current = [];
    } else current.push(p);
  }
  if (current.length > 1) out.push(current);
  return out;
}

/** What every element converted from one legacy element shares. */
interface LegacyContext {
  /** Legacy id → board id. */
  idMap: Map<string, string>;
  /** The next order key (keys are handed out in drawing order). */
  nextKey: () => string;
  /** Link, lock and author, spread last into every element. */
  common: Partial<BoardElement>;
}

/** A board id for every legacy element: its own when valid and not taken, else a fresh one. */
function legacyIdMap(valid: LegacyElement[]): Map<string, string> {
  const idMap = new Map<string, string>();
  let fresh = 0;
  for (const e of valid) {
    const raw = String(e.id ?? '');
    if (isId(raw) && !idMap.has(raw)) {
      idMap.set(raw, raw);
    } else {
      fresh++;
      idMap.set(raw, `lg${fresh.toString(36)}_${raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`);
    }
  }
  return idMap;
}

function commonOf(e: LegacyElement, by: Partial<BoardElement>): Partial<BoardElement> {
  return {
    ...(safeUrl(e.link) ? { link: safeUrl(e.link) } : {}),
    ...(e.locked ? { locked: true } : {}),
    ...by,
  };
}

function strokeWidthOf(e: LegacyElement, min: number): number {
  return Math.min(200, Math.max(min, n(e.strokeWidth, 2)));
}

function fromLegacyRectangle(e: LegacyElement, id: string, ctx: LegacyContext): BoardElement {
  const radius = n(e.borderRadius);
  return {
    id,
    type: 'shape',
    shape: 'rectangle',
    order: ctx.nextKey(),
    x: n(e.x),
    y: n(e.y),
    w: Math.abs(n(e.width, 100)),
    h: Math.abs(n(e.height, 100)),
    fill: colorOr(e.color, 'transparent'),
    stroke: colorOr(e.strokeColor, DEFAULT_STROKE),
    strokeWidth: strokeWidthOf(e, 0),
    ...(radius > 0 ? { radius } : {}),
    ...ctx.common,
  };
}

function fromLegacyCircle(e: LegacyElement, id: string, ctx: LegacyContext): BoardElement {
  const rx = Math.abs(n(e.radiusX, n(e.radius, 50)));
  const ry = Math.abs(n(e.radiusY, n(e.radius, 50)));
  return {
    id,
    type: 'shape',
    shape: 'ellipse',
    order: ctx.nextKey(),
    x: n(e.x) - rx,
    y: n(e.y) - ry,
    w: rx * 2,
    h: ry * 2,
    fill: colorOr(e.color, 'transparent'),
    stroke: colorOr(e.strokeColor, DEFAULT_STROKE),
    strokeWidth: strokeWidthOf(e, 0),
    ...ctx.common,
  };
}

/** The left edge of a text box `w` wide whose anchor `x` is its left, centre or right. */
function leftOfAnchor(x: number, w: number, align: TextAlign): number {
  if (align === 'center') return x - w / 2;
  if (align === 'right') return x - w;
  return x;
}

/** The anchor of a text box at `x`, `w` wide: its left, centre or right. */
function anchorOf(x: number, w: number, align: TextAlign): number {
  if (align === 'center') return x + w / 2;
  if (align === 'right') return x + w;
  return x;
}

function fromLegacyText(e: LegacyElement, id: string, ctx: LegacyContext): BoardElement {
  const text = String(e.text ?? '').slice(0, 20_000);
  const fontSize = Math.min(1000, Math.max(1, n(e.fontSize, 16)));
  const w = textWidth(text, fontSize);
  const lines = Math.max(1, text.split('\n').length);
  const align = e.textAlign === 'center' || e.textAlign === 'right' ? e.textAlign : 'left';
  const marks: Marks = {};
  if (e.fontWeight === 'bold') marks.b = true;
  if (e.fontStyle === 'italic') marks.i = true;
  if (e.textDecoration === 'underline') marks.u = true;
  return {
    id,
    type: 'text',
    order: ctx.nextKey(),
    x: leftOfAnchor(n(e.x), w, align),
    y: n(e.y) - fontSize,
    w,
    h: lines * fontSize * 1.3,
    text: { text, marks: wholeMarks(text, marks) },
    fontSize,
    textColor: colorOr(e.color, '#1f2937'),
    textAlign: align,
    vAlign: 'top',
    ...ctx.common,
  };
}

function fromLegacySticky(e: LegacyElement, id: string, ctx: LegacyContext): BoardElement {
  const size = Math.abs(n(e.width, 200));
  return {
    id,
    type: 'sticky',
    order: ctx.nextKey(),
    x: n(e.x),
    y: n(e.y),
    w: size,
    h: Math.abs(n(e.height, size)),
    fill: colorOr(e.color, STICKY_COLORS[0]),
    text: plain(String(e.text ?? '').slice(0, 20_000)),
    fontSize: Math.min(1000, Math.max(1, n(e.fontSize, 16))),
    textAlign: 'center',
    vAlign: 'middle',
    autoFit: true,
    ...ctx.common,
  };
}

/** A pen stroke per part of the path the eraser left; the first keeps the path's id. */
function fromLegacyPath(e: LegacyElement, id: string, ctx: LegacyContext): BoardElement[] {
  const pts = (Array.isArray(e.points) ? e.points : []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const strokes = eraseStroke(pts, Array.isArray(e.erasedPaths) ? e.erasedPaths : []);
  return strokes.map((stroke, i): BoardElement => {
    const minX = Math.min(...stroke.map((p) => p.x));
    const minY = Math.min(...stroke.map((p) => p.y));
    const maxX = Math.max(...stroke.map((p) => p.x));
    const maxY = Math.max(...stroke.map((p) => p.y));
    const flat: number[] = [];
    for (const p of stroke.slice(0, 30_000)) flat.push(p.x - minX, p.y - minY, 0.5);
    return {
      id: i === 0 ? id : `${id.slice(0, 56)}_p${i}`,
      type: 'pen',
      order: ctx.nextKey(),
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      points: flat,
      stroke: colorOr(e.strokeColor ?? e.color, DEFAULT_STROKE),
      strokeWidth: strokeWidthOf(e, 1),
      ...ctx.common,
    };
  });
}

/** A connector end's binding to the element a legacy arrow end was attached to. */
function legacyBinding(idMap: Map<string, string>, elId: unknown, side: unknown): Partial<ConnectorEnd> {
  const target = typeof elId === 'string' ? idMap.get(elId) : undefined;
  if (!target) return {};
  return { el: target, side: typeof side === 'string' && SIDES.includes(side) ? (side as Side) : 'auto' };
}

/** An elbow arrow stays one; any other is curved when `curved`, else straight. */
function legacyRoute(arrowType: LegacyElement['arrowType'], curved: boolean): ConnectorRoute {
  if (arrowType === 'elbow') return 'elbow';
  return curved ? 'curved' : 'straight';
}

function fromLegacyArrow(e: LegacyElement, id: string, ctx: LegacyContext): BoardElement {
  const sx = n(e.x);
  const sy = n(e.y);
  const ex = n(e.endX, sx);
  const ey = n(e.endY, sy);
  const start: ConnectorEnd = { x: sx, y: sy, ...legacyBinding(ctx.idMap, e.startElementId, e.startConnectionPoint) };
  const end: ConnectorEnd = { x: ex, y: ey, ...legacyBinding(ctx.idMap, e.endElementId, e.endConnectionPoint) };
  const hasControl = e.curveControlX !== undefined && e.curveControlY !== undefined;
  const connected = !!(start.el && end.el && e.startConnectionPoint && e.endConnectionPoint);
  const route = legacyRoute(e.arrowType, hasControl || connected);
  return {
    id,
    type: 'connector',
    order: ctx.nextKey(),
    x: Math.min(sx, ex),
    y: Math.min(sy, ey),
    w: Math.abs(ex - sx),
    h: Math.abs(ey - sy),
    start,
    end,
    route,
    startCap: 'none',
    endCap: e.arrowType === 'line' ? 'none' : 'arrow',
    stroke: colorOr(e.strokeColor ?? e.color, DEFAULT_STROKE),
    strokeWidth: strokeWidthOf(e, 1),
    // The old curve was a cubic with both control points at C: halfway it passes 1/8 S + 3/4 C + 1/8 E.
    ...(hasControl && route === 'curved'
      ? { control: { x: 0.125 * sx + 0.75 * n(e.curveControlX) + 0.125 * ex, y: 0.125 * sy + 0.75 * n(e.curveControlY) + 0.125 * ey } }
      : {}),
    ...ctx.common,
  };
}

/** The board elements for one legacy element (none for a type the format does not have). */
function fromLegacyElement(e: LegacyElement, id: string, ctx: LegacyContext): BoardElement[] {
  switch (e.type) {
    case 'rectangle':
      return [fromLegacyRectangle(e, id, ctx)];
    case 'circle':
      return [fromLegacyCircle(e, id, ctx)];
    case 'text':
      return [fromLegacyText(e, id, ctx)];
    case 'sticky':
      return [fromLegacySticky(e, id, ctx)];
    case 'path':
      return fromLegacyPath(e, id, ctx);
    case 'arrow':
      return [fromLegacyArrow(e, id, ctx)];
    default:
      return [];
  }
}

/**
 * The board elements for WeldFlow elements, in drawing order. `idFor`
 * keeps ids stable (an old id that is valid stays the same, so legacy
 * bindings and API callers keep pointing at the same element).
 */
export function fromLegacyElements(elements: unknown[], options: { createdBy?: string } = {}): BoardElement[] {
  const valid = elements.filter((e): e is LegacyElement => typeof e === 'object' && e !== null && typeof (e as LegacyElement).type === 'string');
  const idMap = legacyIdMap(valid);
  const out: BoardElement[] = [];
  const keys = keysBetween(null, null, Math.max(1, valid.length * 2));
  let k = 0;
  const nextKey = () => keys[k++] ?? keys[keys.length - 1]!;
  const by = options.createdBy ? { createdBy: options.createdBy } : {};

  for (const e of valid) {
    const id = idMap.get(String(e.id ?? ''))!;
    out.push(...fromLegacyElement(e, id, { idMap, nextKey, common: commonOf(e, by) }));
  }
  // Connectors draw under everything else, as they did.
  const connectors = out.filter((e) => e.type === 'connector');
  const rest = out.filter((e) => e.type !== 'connector');
  const ordered = [...connectors, ...rest];
  const finalKeys = keysBetween(null, null, Math.max(1, ordered.length));
  ordered.forEach((e, i) => (e.order = finalKeys[i]!));
  return ordered;
}

/** Orders strings by UTF-16 code units, as `<` does. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** A board snapshot for a WeldFlow whiteboard. */
export function convertLegacyWhiteboard(elements: unknown[], options: { createdBy?: string } = {}): BoardSnapshot {
  const els = fromLegacyElements(elements, options).sort((a, b) => compareStrings(a.id, b.id));
  return { version: SNAPSHOT_VERSION, props: {}, elements: els };
}

/** What every legacy element keeps of a board element: its link and lock. */
function legacyExtra(el: BoardElement): Partial<LegacyElement> {
  return {
    ...(el.link ? { link: el.link } : {}),
    ...(el.locked ? { locked: true } : {}),
  };
}

function toLegacyShape(el: BoardElement, extra: Partial<LegacyElement>): LegacyElement {
  if (el.shape === 'ellipse') {
    return {
      id: el.id, type: 'circle', x: el.x + el.w / 2, y: el.y + el.h / 2, radiusX: el.w / 2, radiusY: el.h / 2,
      color: el.fill, strokeColor: el.stroke, strokeWidth: el.strokeWidth, ...extra,
    };
  }
  return {
    id: el.id, type: 'rectangle', x: el.x, y: el.y, width: el.w, height: el.h,
    color: el.fill, strokeColor: el.stroke, strokeWidth: el.strokeWidth,
    ...(el.radius ? { borderRadius: el.radius } : {}), ...extra,
  };
}

function toLegacyText(el: BoardElement, extra: Partial<LegacyElement>): LegacyElement {
  const fontSize = el.fontSize ?? 16;
  const align = el.textAlign ?? 'left';
  const marks = el.text?.marks[0]?.[1] ?? {};
  return {
    id: el.id, type: 'text', x: anchorOf(el.x, el.w, align), y: el.y + fontSize, text: el.text?.text ?? '', color: el.textColor, fontSize,
    textAlign: align, ...(marks.b ? { fontWeight: 'bold' } : {}), ...(marks.i ? { fontStyle: 'italic' } : {}),
    ...(marks.u ? { textDecoration: 'underline' } : {}), ...extra,
  };
}

function toLegacyPath(el: BoardElement, extra: Partial<LegacyElement>): LegacyElement {
  const pts = el.points ?? [];
  const points: LegacyPoint[] = [];
  for (let i = 0; i + 1 < pts.length; i += 3) points.push({ x: el.x + pts[i]!, y: el.y + pts[i + 1]! });
  return { id: el.id, type: 'path', x: el.x, y: el.y, points, strokeColor: el.stroke, strokeWidth: el.strokeWidth, ...extra };
}

/** The side an end is attached at, unless it picks one itself. */
function fixedSide(end: ConnectorEnd | undefined): Side | undefined {
  return end?.side && end.side !== 'auto' ? end.side : undefined;
}

function legacyArrowType(el: BoardElement): LegacyElement['arrowType'] {
  if (el.route === 'elbow') return 'elbow';
  return el.endCap === 'none' ? 'line' : 'arrow';
}

function legacyStartBinding(end: ConnectorEnd | undefined): Partial<LegacyElement> {
  if (!end?.el) return {};
  const side = fixedSide(end);
  return { startElementId: end.el, ...(side ? { startConnectionPoint: side } : {}) };
}

function legacyEndBinding(end: ConnectorEnd | undefined): Partial<LegacyElement> {
  if (!end?.el) return {};
  const side = fixedSide(end);
  return { endElementId: end.el, ...(side ? { endConnectionPoint: side } : {}) };
}

function toLegacyArrow(board: Board, el: BoardElement, extra: Partial<LegacyElement>): LegacyElement {
  const g = connectorGeometry(board, el);
  return {
    id: el.id,
    type: 'arrow',
    x: g.start.p.x,
    y: g.start.p.y,
    endX: g.end.p.x,
    endY: g.end.p.y,
    arrowType: legacyArrowType(el),
    strokeColor: el.stroke,
    strokeWidth: el.strokeWidth,
    ...legacyStartBinding(el.start),
    ...legacyEndBinding(el.end),
    ...extra,
  };
}

/** The legacy element for a board element, or null for a type WeldFlow did not know. */
function toLegacyElement(board: Board, el: BoardElement): LegacyElement | null {
  const extra = legacyExtra(el);
  switch (el.type) {
    case 'sticky':
      return { id: el.id, type: 'sticky', x: el.x, y: el.y, width: el.w, height: el.h, text: el.text?.text ?? '', color: el.fill, fontSize: el.fontSize, ...extra };
    case 'shape':
      return toLegacyShape(el, extra);
    case 'text':
      return toLegacyText(el, extra);
    case 'pen':
      return toLegacyPath(el, extra);
    case 'connector':
      return toLegacyArrow(board, el, extra);
    default:
      return null;
  }
}

/** The board as WeldFlow elements, for the deprecated API (types WeldFlow knew; other elements are left out). */
export function toLegacyElements(board: Board): LegacyElement[] {
  const out: LegacyElement[] = [];
  for (const el of board.paintOrder()) {
    const legacy = toLegacyElement(board, el);
    if (legacy) out.push(legacy);
  }
  return out;
}

const LEGACY_TYPES = new Set(['sticky', 'shape', 'text', 'pen', 'connector']);

/**
 * The ops that make the board match a legacy `elements[]` write: changed
 * elements are set, new ones created, missing ones deleted. Elements the
 * legacy format cannot show (frames, cards, images, …) are left alone.
 */
export function legacyWriteOps(board: Board, elements: unknown[]): Op {
  const wanted = fromLegacyElements(elements);
  const current = new Map(toLegacyElements(board).map((e) => [e.id, stable(e)]));
  const incoming = new Map(
    (elements.filter((e) => typeof e === 'object' && e !== null) as LegacyElement[]).map((e) => [String(e.id), e]),
  );
  const ops: Op[] = [];
  const seen = new Set<string>();
  let top = board.topOrder(null);
  for (const el of wanted) {
    seen.add(el.id);
    const existing = board.get(el.id);
    if (!existing) {
      const order = keysBetween(top, null, 1)[0]!;
      top = order;
      ops.push({ type: 'create', elements: [{ ...el, order }] });
      continue;
    }
    const before = current.get(el.id);
    const legacy = incoming.get(el.id);
    // Unchanged: the caller sent back what it read.
    if (before && legacy && stable(legacy) === before) continue;
    ops.push(...changeOps(existing, el));
  }
  const gone = goneIds(board, seen);
  if (gone.length) ops.push({ type: 'delete', ids: gone });
  return batch(ops);
}

/** The ops turning `existing` into `el`: a set of what changed, or a replacement when the type did. */
function changeOps(existing: BoardElement, el: BoardElement): Op[] {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(el)) {
    if (key === 'id' || key === 'type' || key === 'order' || key === 'createdBy') continue;
    if (JSON.stringify((existing as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)) patch[key] = value;
  }
  if (existing.type !== el.type) return [{ type: 'delete', ids: [el.id] }, { type: 'create', elements: [{ ...el, order: existing.order }] }];
  return Object.keys(patch).length ? [{ type: 'set', id: el.id, patch }] : [];
}

/** Elements the legacy format shows that the write left out (mind-map nodes stay). */
function goneIds(board: Board, seen: Set<string>): string[] {
  const gone: string[] = [];
  for (const el of board.elements.values()) {
    if (!LEGACY_TYPES.has(el.type) || seen.has(el.id)) continue;
    if (el.type === 'shape' && el.mindmap) continue;
    gone.push(el.id);
  }
  return gone;
}

/** JSON with sorted keys and undefined values dropped, to compare elements whatever their key order. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => compareStrings(a, b));
    const body = entries.map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',');
    return `{${body}}`;
  }
  return JSON.stringify(v);
}
