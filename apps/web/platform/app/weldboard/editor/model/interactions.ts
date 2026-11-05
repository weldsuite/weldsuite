/**
 * Pointer input: what a press, a drag and a release do with each tool.
 * Screen points are CSS pixels relative to the canvas. Ops are applied as
 * the pointer moves (so collaborators see a drag live), merged into one undo
 * step per gesture.
 */

import {
  addMindMapChild,
  adoptOps,
  batch,
  connectorGeometry,
  distance,
  elementBounds,
  elementInRect,
  elementTextLayout,
  facingSide,
  fitGroupOps,
  keyBetween,
  makeCard,
  makeConnector,
  makeFrame,
  makeShape,
  makeSticky,
  makeText,
  makeFragment,
  mindMapLayoutOps,
  moveOps,
  newId,
  nearestAlong,
  offsetAt,
  placeFragment,
  rectFromPoints,
  reparentOps,
  rotatePoint,
  selectionBounds,
  snapRect,
  type BoardElement,
  type ConnectorEnd,
  type Op,
  type Point,
  type Rect,
  type Side,
} from '@weldsuite/board-engine';
import type { BoardController } from './board-controller';
import { toBoard, toScreen, zoomAt } from './camera';

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type Handle =
  | { kind: 'resize'; handle: ResizeHandle }
  | { kind: 'rotate' }
  | { kind: 'end'; which: 'start' | 'end' }
  | { kind: 'control' }
  | { kind: 'connect'; side: Side }
  | { kind: 'label' };

type Drag =
  | { kind: 'pan'; start: Point; camera: { x: number; y: number; zoom: number } }
  | { kind: 'marquee'; start: Point; base: Set<string> }
  | { kind: 'move'; start: Point; ids: string[]; startBounds: Rect; applied: Point; gesture: string; moved: boolean }
  | { kind: 'resize'; handle: ResizeHandle; ids: string[]; startBox: Rect; rotation: number; origin: Map<string, BoardElement>; gesture: string; keepRatio: boolean }
  | { kind: 'rotate'; center: Point; startAngle: number; origin: Map<string, BoardElement>; gesture: string }
  | { kind: 'create'; start: Point; current: Point }
  | { kind: 'connector'; from: ConnectorEnd; current: Point; target: ConnectorEnd | null; existing: { id: string; which: 'start' | 'end' } | null; gesture: string }
  | { kind: 'control'; id: string; gesture: string }
  | { kind: 'label'; id: string; gesture: string }
  | { kind: 'stroke'; points: Point[]; pressure: number[] }
  | { kind: 'erase'; last: Point; erased: Set<string> }
  | { kind: 'text-select'; id: string; anchor: number };

export interface PointerInfo {
  screen: Point;
  button: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  pressure: number;
  pointerType: string;
}

const HANDLE_RADIUS = 7;
const ROTATE_OFFSET = 26;
const CONNECT_OFFSET = 18;
const DRAG_START = 3;

function gestureId(kind: string): string {
  return `${kind}:${Math.random().toString(36).slice(2, 10)}`;
}

/** The box handles are drawn around: one element's own (rotated) box, or a selection's bounds. */
export function selectionFrame(c: BoardController): { box: Rect; rotation: number } | null {
  const els = c.selected;
  if (els.length === 0) return null;
  if (els.length === 1) {
    const el = els[0]!;
    if (el.type === 'connector') return null;
    if (el.type === 'pen') return { box: elementBounds(c.board, el), rotation: 0 };
    return { box: { x: el.x, y: el.y, w: el.w, h: el.h }, rotation: el.rotation ?? 0 };
  }
  const b = selectionBounds(c.board, c.selection);
  return b ? { box: b, rotation: 0 } : null;
}

/** Where each handle sits on screen. */
export function handlePositions(c: BoardController): { handle: Handle; at: Point }[] {
  const out: { handle: Handle; at: Point }[] = [];
  const els = c.selected;
  if (c.readOnly || c.editing || els.some((e) => e.locked)) return out;
  if (els.length === 1 && els[0]!.type === 'connector') {
    const el = els[0]!;
    const g = connectorGeometry(c.board, el);
    out.push({ handle: { kind: 'end', which: 'start' }, at: toScreen(c.camera, g.start.p) });
    out.push({ handle: { kind: 'end', which: 'end' }, at: toScreen(c.camera, g.end.p) });
    if (el.route === 'curved') out.push({ handle: { kind: 'control' }, at: toScreen(c.camera, g.label) });
    return out;
  }
  const frame = selectionFrame(c);
  if (!frame) return out;
  const { box, rotation } = frame;
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const local: Record<ResizeHandle, Point> = {
    nw: { x: box.x, y: box.y },
    n: { x: center.x, y: box.y },
    ne: { x: box.x + box.w, y: box.y },
    e: { x: box.x + box.w, y: center.y },
    se: { x: box.x + box.w, y: box.y + box.h },
    s: { x: center.x, y: box.y + box.h },
    sw: { x: box.x, y: box.y + box.h },
    w: { x: box.x, y: center.y },
  };
  const single = els.length === 1 ? els[0]! : null;
  const sides: ResizeHandle[] = single?.type === 'sticky' ? ['nw', 'ne', 'se', 'sw'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  for (const h of sides) out.push({ handle: { kind: 'resize', handle: h }, at: toScreen(c.camera, rotatePoint(local[h], center, rotation)) });
  if (!single || single.type !== 'pen') {
    const top = toScreen(c.camera, rotatePoint(local.n, center, rotation));
    const up = rotatePoint({ x: 0, y: -ROTATE_OFFSET }, { x: 0, y: 0 }, rotation);
    out.push({ handle: { kind: 'rotate' }, at: { x: top.x + up.x, y: top.y + up.y } });
  }
  if (single && isConnectable(single) && c.tool === 'select') {
    const sideAt: Record<Side, ResizeHandle> = { top: 'n', right: 'e', bottom: 's', left: 'w' };
    for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
      const p = toScreen(c.camera, rotatePoint(local[sideAt[side]], center, rotation));
      const dir = rotatePoint({ x: side === 'right' ? 1 : side === 'left' ? -1 : 0, y: side === 'bottom' ? 1 : side === 'top' ? -1 : 0 }, { x: 0, y: 0 }, rotation);
      out.push({ handle: { kind: 'connect', side }, at: { x: p.x + dir.x * CONNECT_OFFSET, y: p.y + dir.y * CONNECT_OFFSET } });
    }
  }
  return out;
}

export function isConnectable(el: BoardElement): boolean {
  return el.type !== 'connector' && el.type !== 'pen' && el.type !== 'group' && el.type !== 'comment';
}

/** The top-level group an element is in, if any (a click selects the whole group). */
function outerGroup(c: BoardController, el: BoardElement): BoardElement {
  let current: BoardElement = el;
  let found: BoardElement = el;
  for (let guard = 0; guard < 50; guard++) {
    const p = current.parent ? c.board.get(current.parent) : undefined;
    if (!p) break;
    if (p.type === 'group') found = p;
    current = p;
  }
  return found;
}

const RESIZE_CURSORS: Record<ResizeHandle, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };

export function cursorForHandle(handle: Handle, rotation: number): string {
  if (handle.kind === 'rotate') return 'grab';
  if (handle.kind !== 'resize') return 'crosshair';
  const deg = (RESIZE_CURSORS[handle.handle] + (rotation * 180) / Math.PI + 360) % 180;
  if (deg < 22.5 || deg >= 157.5) return 'ns-resize';
  if (deg < 67.5) return 'nesw-resize';
  if (deg < 112.5) return 'ew-resize';
  return 'nwse-resize';
}

export class Interactions {
  private drag: Drag | null = null;
  private downAt: Point | null = null;
  /** Pointer ids currently down (two touches pinch). */
  private readonly touches = new Map<number, Point>();
  private pinch: { distance: number; mid: Point; camera: { x: number; y: number; zoom: number } } | null = null;
  spaceDown = false;
  /** Called when a comment pin is placed or opened. */
  onComment: ((id: string) => void) | null = null;
  /** Called when the person double-clicks a frame's title. */
  onRenameFrame: ((id: string) => void) | null = null;
  /** Called to pick an image for the image tool. */
  onPickImage: ((at: Point) => void) | null = null;

  constructor(private readonly c: BoardController) {}

  get dragging(): boolean {
    return this.drag !== null;
  }

  private tolerance(): number {
    return 6 / this.c.camera.zoom;
  }

  hitHandle(screen: Point): Handle | null {
    let best: { h: Handle; d: number } | null = null;
    for (const { handle, at } of handlePositions(this.c)) {
      const d = distance(screen, at);
      if (d <= HANDLE_RADIUS + 3 && (!best || d < best.d)) best = { h: handle, d };
    }
    return best?.h ?? null;
  }

  /** What the cursor should look like at a point. */
  cursorAt(screen: Point): string {
    const c = this.c;
    if (this.drag?.kind === 'pan' || (this.spaceDown && !this.drag)) return this.drag ? 'grabbing' : 'grab';
    if (c.tool === 'hand') return 'grab';
    if (c.tool !== 'select') return c.tool === 'text' ? 'text' : 'crosshair';
    const h = this.hitHandle(screen);
    if (h) return cursorForHandle(h, selectionFrame(c)?.rotation ?? 0);
    const p = toBoard(c.camera, screen);
    const el = c.index.hit(p, this.tolerance());
    if (el && c.editing?.id === el.id) return 'text';
    return el ? (el.locked ? 'default' : 'move') : 'default';
  }

  // ---------------------------------------------------------------- touch

  touchDown(id: number, screen: Point): boolean {
    this.touches.set(id, screen);
    if (this.touches.size === 2) {
      // A second finger: whatever the first started becomes a pinch.
      this.cancel();
      const [a, b] = [...this.touches.values()] as [Point, Point];
      this.pinch = { distance: distance(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, camera: { ...this.c.camera } };
      return true;
    }
    return false;
  }

  touchMove(id: number, screen: Point): boolean {
    if (!this.touches.has(id)) return false;
    this.touches.set(id, screen);
    if (!this.pinch || this.touches.size < 2) return false;
    const [a, b] = [...this.touches.values()] as [Point, Point];
    const d = distance(a, b);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const start = this.pinch.camera;
    let cam = zoomAt(start, start.zoom * (d / Math.max(1, this.pinch.distance)), this.pinch.mid);
    cam = { ...cam, x: cam.x - (mid.x - this.pinch.mid.x) / cam.zoom, y: cam.y - (mid.y - this.pinch.mid.y) / cam.zoom };
    this.c.setCamera(cam);
    return true;
  }

  touchUp(id: number): boolean {
    this.touches.delete(id);
    if (this.pinch && this.touches.size < 2) {
      this.pinch = null;
      this.c.changed();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- wheel

  wheel(screen: Point, dx: number, dy: number, zoomGesture: boolean): void {
    const c = this.c;
    if (zoomGesture) {
      const factor = Math.exp(-dy * 0.0025);
      c.setCamera(zoomAt(c.camera, c.camera.zoom * factor, screen), true);
    } else {
      c.setCamera({ ...c.camera, x: c.camera.x + dx / c.camera.zoom, y: c.camera.y + dy / c.camera.zoom }, true);
    }
    if (c.following) c.follow(null);
  }

  // ---------------------------------------------------------------- pointer

  down(info: PointerInfo): void {
    const c = this.c;
    const p = toBoard(c.camera, info.screen);
    this.downAt = info.screen;
    c.cursor = p;
    if (c.following) c.follow(null);

    if (info.button === 1 || this.spaceDown || c.tool === 'hand') {
      this.drag = { kind: 'pan', start: info.screen, camera: { ...c.camera } };
      return;
    }
    if (info.button !== 0) return;
    if (c.readOnly) {
      if (c.tool === 'comment' && c.canComment) this.placeComment(p);
      else this.drag = { kind: 'pan', start: info.screen, camera: { ...c.camera } };
      return;
    }

    switch (c.tool) {
      case 'select':
        this.downSelect(info, p);
        return;
      case 'sticky':
        this.placeSticky(p);
        return;
      case 'shape':
      case 'frame':
      case 'text':
      case 'card':
        this.drag = { kind: 'create', start: p, current: p };
        c.transient = { creating: { x: p.x, y: p.y, w: 0, h: 0 } };
        return;
      case 'connector': {
        const target = this.snapTarget(p, null);
        this.drag = { kind: 'connector', from: target ?? { x: p.x, y: p.y }, current: p, target: null, existing: null, gesture: gestureId('connect') };
        return;
      }
      case 'pen':
      case 'highlighter':
        this.drag = { kind: 'stroke', points: [p], pressure: [info.pointerType === 'pen' ? info.pressure : 0.5] };
        return;
      case 'eraser':
        this.drag = { kind: 'erase', last: p, erased: new Set() };
        this.eraseAt(p);
        return;
      case 'comment':
        this.placeComment(p);
        return;
      case 'mindmap':
        this.placeMindMap(p);
        return;
      default:
        return;
    }
  }

  private downSelect(info: PointerInfo, p: Point): void {
    const c = this.c;
    // Inside the text being edited: place the caret / start a text selection.
    if (c.editing) {
      const el = c.board.get(c.editing.id);
      if (el && this.pointInTextBox(el, p)) {
        const pos = this.textOffsetAt(el, p);
        if (pos !== null) {
          c.editing = info.shift ? { ...c.editing, head: pos, goalX: undefined } : { id: el.id, anchor: pos, head: pos };
          this.drag = { kind: 'text-select', id: el.id, anchor: c.editing.anchor };
          c.changed();
          return;
        }
      }
      c.stopEditing();
    }

    const handle = this.hitHandle(info.screen);
    if (handle) {
      this.startHandleDrag(handle, p, info);
      return;
    }

    const hit = c.index.hit(p, this.tolerance());
    if (hit) {
      const target = c.selection.has(hit.id) ? hit : outerGroup(c, hit);
      if (hit.type === 'comment') this.onComment?.(hit.id);
      if (info.shift) {
        const next = new Set(c.selection);
        if (next.has(target.id)) next.delete(target.id);
        else next.add(target.id);
        c.select(next);
        return;
      }
      if (!c.selection.has(target.id)) c.select([target.id]);
      const movable = c.selected.filter((e) => !e.locked);
      if (movable.length === 0) return;
      let ids = movable.map((e) => e.id);
      const gesture = gestureId('move');
      if (info.alt) {
        // Alt-drag: drag a copy.
        const fragment = makeFragment(c.board, ids);
        const b = selectionBounds(c.board, ids)!;
        const placed = placeFragment(c.board, fragment, { x: b.x, y: b.y, createdBy: c.options.userId, now: Date.now() });
        c.apply(placed.op, { gesture, select: placed.ids });
        ids = placed.ids;
      }
      this.drag = { kind: 'move', start: p, ids, startBounds: selectionBounds(c.board, ids)!, applied: { x: 0, y: 0 }, gesture, moved: false };
      return;
    }

    this.drag = { kind: 'marquee', start: p, base: info.shift ? new Set(c.selection) : new Set() };
    if (!info.shift) c.select([]);
  }

  private startHandleDrag(handle: Handle, p: Point, info: PointerInfo): void {
    const c = this.c;
    const els = c.selected;
    const origin = new Map(els.map((e) => [e.id, e]));
    for (const e of els) if (e.type === 'frame' || e.type === 'group') for (const d of c.board.descendants(e.id)) origin.set(d, c.board.get(d)!);
    switch (handle.kind) {
      case 'resize': {
        const frame = selectionFrame(c)!;
        const keepRatio = info.shift || els.some((e) => e.type === 'sticky' || e.type === 'image' || e.type === 'pen') || els.length > 1;
        this.drag = { kind: 'resize', handle: handle.handle, ids: els.map((e) => e.id), startBox: frame.box, rotation: frame.rotation, origin, gesture: gestureId('resize'), keepRatio };
        return;
      }
      case 'rotate': {
        const frame = selectionFrame(c)!;
        const center = { x: frame.box.x + frame.box.w / 2, y: frame.box.y + frame.box.h / 2 };
        this.drag = { kind: 'rotate', center, startAngle: Math.atan2(p.y - center.y, p.x - center.x), origin, gesture: gestureId('rotate') };
        return;
      }
      case 'end': {
        const el = els[0]!;
        const g = connectorGeometry(c.board, el);
        const other = handle.which === 'start' ? el.end : el.start;
        const otherPoint = handle.which === 'start' ? g.end.p : g.start.p;
        this.drag = {
          kind: 'connector',
          from: other ?? { x: otherPoint.x, y: otherPoint.y },
          current: p,
          target: null,
          existing: { id: el.id, which: handle.which },
          gesture: gestureId('connect'),
        };
        return;
      }
      case 'control':
        this.drag = { kind: 'control', id: els[0]!.id, gesture: gestureId('curve') };
        return;
      case 'label':
        this.drag = { kind: 'label', id: els[0]!.id, gesture: gestureId('label') };
        return;
      case 'connect': {
        const el = els[0]!;
        this.drag = { kind: 'connector', from: { x: p.x, y: p.y, el: el.id, side: handle.side }, current: p, target: null, existing: null, gesture: gestureId('connect') };
        return;
      }
    }
  }

  move(info: PointerInfo): void {
    const c = this.c;
    const p = toBoard(c.camera, info.screen);
    c.cursor = p;
    const drag = this.drag;
    if (!drag) {
      // Hover: outline what the pointer is over.
      if (c.tool === 'select' || c.tool === 'connector' || c.tool === 'eraser') {
        const hit = c.index.hit(p, this.tolerance());
        const hover = hit?.id ?? null;
        if (hover !== (c.transient.hover ?? null)) {
          c.transient = { ...c.transient, hover };
          c.changed(false);
        }
      }
      return;
    }
    const far = this.downAt ? distance(this.downAt, info.screen) > DRAG_START : true;
    switch (drag.kind) {
      case 'pan':
        c.setCamera({ ...drag.camera, x: drag.camera.x - (info.screen.x - drag.start.x) / drag.camera.zoom, y: drag.camera.y - (info.screen.y - drag.start.y) / drag.camera.zoom });
        return;
      case 'marquee': {
        const r = rectFromPoints(drag.start, p);
        // A frame the marquee takes brings its contents along: don't select those twice.
        const touched = new Set(c.index.inRect(r, false).map((e) => outerGroup(c, e).id));
        const next = new Set(drag.base);
        for (const id of touched) {
          const el = c.board.get(id);
          if (!el || el.locked) continue;
          let covered = false;
          for (let p2 = el.parent ? c.board.get(el.parent) : undefined; p2 && !covered; p2 = p2.parent ? c.board.get(p2.parent) : undefined) {
            if (touched.has(p2.id) && p2.type === 'frame' && elementInRect(c.board, p2, r, false)) covered = true;
          }
          if (!covered) next.add(id);
        }
        c.selection = next;
        c.transient = { marquee: r };
        c.changed();
        return;
      }
      case 'move': {
        if (!drag.moved && !far) return;
        drag.moved = true;
        let dx = p.x - drag.start.x;
        let dy = p.y - drag.start.y;
        const guides = [];
        if (!info.alt) {
          const moving = { ...drag.startBounds, x: drag.startBounds.x + dx, y: drag.startBounds.y + dy };
          const snap = snapRect(moving, this.neighbours(moving, new Set(drag.ids)), 6 / c.camera.zoom);
          dx += snap.dx;
          dy += snap.dy;
          guides.push(...snap.guides);
        }
        const step = { x: dx - drag.applied.x, y: dy - drag.applied.y };
        if (step.x || step.y) {
          c.apply(moveOps(c.board, drag.ids, step.x, step.y), { gesture: drag.gesture });
          drag.applied = { x: dx, y: dy };
        }
        const moved = selectionBounds(c.board, drag.ids);
        const frame = moved ? this.frameUnder(moved, new Set(drag.ids)) : null;
        c.transient = { guides, dropTarget: frame };
        c.changed(false);
        return;
      }
      case 'resize':
        this.resizeTo(drag, p, info);
        return;
      case 'rotate': {
        let angle = Math.atan2(p.y - drag.center.y, p.x - drag.center.x) - drag.startAngle;
        if (info.shift) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        const ops: Op[] = [];
        for (const [id, el] of drag.origin) {
          if (el.type === 'connector') continue;
          const cx = el.x + el.w / 2;
          const cy = el.y + el.h / 2;
          const nc = rotatePoint({ x: cx, y: cy }, drag.center, angle);
          const patch: Record<string, unknown> = { x: nc.x - el.w / 2, y: nc.y - el.h / 2 };
          if (el.type !== 'pen') patch.rotation = normalizeAngle((el.rotation ?? 0) + angle);
          ops.push({ type: 'set', id, patch });
        }
        c.apply(batch(ops), { gesture: drag.gesture });
        return;
      }
      case 'create':
        drag.current = p;
        c.transient = { creating: this.createRect(drag.start, p, info.shift) };
        c.changed(false);
        return;
      case 'connector': {
        drag.current = p;
        drag.target = this.snapTarget(p, drag.existing?.id ?? null);
        c.transient = { connector: { points: this.previewConnector(drag), target: drag.target?.el ?? null }, hover: drag.target?.el ?? null };
        c.changed(false);
        return;
      }
      case 'control': {
        c.apply({ type: 'set', id: drag.id, patch: { control: { x: p.x, y: p.y } } }, { gesture: drag.gesture });
        return;
      }
      case 'label': {
        const el = c.board.get(drag.id);
        if (el) c.apply({ type: 'set', id: drag.id, patch: { labelAt: Math.round(nearestAlong(connectorGeometry(c.board, el).points, p) * 1000) / 1000 } }, { gesture: drag.gesture });
        return;
      }
      case 'stroke': {
        drag.points.push(p);
        drag.pressure.push(info.pointerType === 'pen' ? info.pressure : 0.5);
        const highlighter = c.tool === 'highlighter';
        c.transient = {
          stroke: {
            points: drag.points,
            color: highlighter ? c.toolOptions.highlighterColor : c.toolOptions.penColor,
            width: highlighter ? 16 : c.toolOptions.penWidth,
            opacity: highlighter ? 0.45 : 1,
          },
        };
        c.changed(false);
        return;
      }
      case 'erase':
        this.eraseAt(p, drag);
        return;
      case 'text-select': {
        const el = c.board.get(drag.id);
        const pos = el ? this.textOffsetAt(el, p) : null;
        if (pos !== null && c.editing) {
          c.editing = { ...c.editing, anchor: drag.anchor, head: pos };
          c.changed();
        }
        return;
      }
    }
  }

  up(info: PointerInfo): void {
    const c = this.c;
    const drag = this.drag;
    this.drag = null;
    const p = toBoard(c.camera, info.screen);
    if (!drag) return;
    switch (drag.kind) {
      case 'marquee':
        c.transient = {};
        c.changed();
        return;
      case 'move': {
        if (drag.moved) {
          // Dropped onto a frame: it joins it; dragged out: it leaves.
          c.apply(reparentOps(c.board, drag.ids), { gesture: drag.gesture });
          const groups = new Set(drag.ids.map((id) => c.board.get(id)?.parent).filter((x): x is string => !!x && c.board.get(x)?.type === 'group'));
          for (const g of groups) c.apply(fitGroupOps(c.board, g), { gesture: drag.gesture });
        }
        c.history.seal();
        c.transient = {};
        c.changed();
        return;
      }
      case 'resize':
      case 'rotate':
      case 'control':
      case 'label':
        for (const id of c.selection) {
          const el = c.board.get(id);
          if (el?.type === 'frame') c.apply(adoptOps(c.board, id), { gesture: drag.gesture });
        }
        c.history.seal();
        c.transient = {};
        c.changed();
        return;
      case 'create':
        this.finishCreate(drag.start, p, info.shift);
        return;
      case 'connector':
        this.finishConnector(drag);
        return;
      case 'stroke':
        this.finishStroke(drag);
        return;
      case 'erase':
        c.transient = {};
        if (drag.erased.size) c.apply({ type: 'delete', ids: [...drag.erased] });
        c.changed();
        return;
      default:
        c.transient = {};
        c.changed();
    }
  }

  cancel(): void {
    if (this.drag?.kind === 'move' || this.drag?.kind === 'resize' || this.drag?.kind === 'rotate') this.c.history.seal();
    this.drag = null;
    this.c.transient = {};
    this.c.changed();
  }

  doubleClick(info: PointerInfo): void {
    const c = this.c;
    if (c.tool !== 'select') return;
    const p = toBoard(c.camera, info.screen);
    const hit = c.index.hit(p, this.tolerance());
    if (!hit) {
      if (!c.readOnly) this.placeSticky(p);
      return;
    }
    if (hit.type === 'frame' && hit.y > p.y) {
      this.onRenameFrame?.(hit.id);
      return;
    }
    // Inside a group: the first double-click selects the element itself.
    const outer = outerGroup(c, hit);
    if (outer.id !== hit.id && !c.selection.has(hit.id)) {
      c.select([hit.id]);
      return;
    }
    if (c.canEditText(hit) || (hit.type === 'connector' && !hit.locked)) {
      const pos = this.textOffsetAt(hit, p);
      c.startEditing(hit.id, pos ?? undefined);
      if (pos === null) c.editing = { id: hit.id, anchor: 0, head: hit.text?.text.length ?? 0 };
      c.changed();
    }
  }

  // ---------------------------------------------------------------- helpers

  private neighbours(near: Rect, skip: Set<string>): Rect[] {
    const c = this.c;
    const pad = 600 / c.camera.zoom;
    const area = { x: near.x - pad, y: near.y - pad, w: near.w + pad * 2, h: near.h + pad * 2 };
    const out: Rect[] = [];
    for (const id of c.index.query(area)) {
      if (skip.has(id) || out.length > 300) continue;
      const el = c.board.get(id);
      if (!el || el.type === 'connector' || el.type === 'pen' || el.type === 'comment') continue;
      if (skip.has(el.parent ?? '')) continue;
      out.push(c.boundsOf(el));
    }
    return out;
  }

  private frameUnder(r: Rect, skip: Set<string>): string | null {
    const order = this.c.board.paintOrder();
    for (let i = order.length - 1; i >= 0; i--) {
      const f = order[i]!;
      if (f.type !== 'frame' || skip.has(f.id)) continue;
      if (r.x >= f.x && r.y >= f.y && r.x + r.w <= f.x + f.w && r.y + r.h <= f.y + f.h) return f.id;
    }
    return null;
  }

  private createRect(a: Point, b: Point, square: boolean): Rect {
    if (!square) return rectFromPoints(a, b);
    const size = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    return rectFromPoints(a, { x: a.x + Math.sign(b.x - a.x || 1) * size, y: a.y + Math.sign(b.y - a.y || 1) * size });
  }

  private placeAt(): { parent: string | null; order: string } {
    return { parent: null, order: keyBetween(this.c.board.topOrder(null), null) };
  }

  private placement(p: Point): { parent?: string; order: string; createdBy: string; now: number } {
    const c = this.c;
    const frame = this.frameUnder({ x: p.x, y: p.y, w: 0, h: 0 }, new Set());
    const parent = frame ?? null;
    return { ...(parent ? { parent } : {}), order: keyBetween(c.board.topOrder(parent), null), createdBy: c.options.userId, now: Date.now() };
  }

  private placeSticky(p: Point): void {
    const c = this.c;
    const size = 200;
    const el = makeSticky(p.x - size / 2, p.y - size / 2, this.placement(p), { color: c.toolOptions.stickyColor });
    c.apply({ type: 'create', elements: [el] }, { select: [el.id] });
    c.toolDone();
    c.startEditing(el.id, 0);
  }

  private placeComment(p: Point): void {
    const c = this.c;
    const target = c.index.hit(p, this.tolerance());
    const id = newId('cm');
    const el: BoardElement = {
      id,
      type: 'comment',
      order: keyBetween(c.board.topOrder(null), null),
      x: p.x,
      y: p.y,
      w: 0,
      h: 0,
      thread: id,
      createdBy: c.options.userId,
      createdAt: Date.now(),
      ...(target && target.type !== 'comment' ? { target: target.id } : {}),
    };
    if (c.apply({ type: 'create', elements: [el] }, { comment: true, select: [id] })) this.onComment?.(id);
    c.toolDone();
  }

  private placeMindMap(p: Point): void {
    const c = this.c;
    const id = newId();
    const root = makeShape('rounded', p.x - 110, p.y - 40, 220, 80, this.placement(p), { id, fill: '#ede9fe', stroke: '#7c3aed' });
    root.mindmap = { root: id };
    root.fontSize = 20;
    c.apply({ type: 'create', elements: [root] }, { select: [id] });
    c.toolDone();
    c.startEditing(id, 0);
  }

  /** Adds a child (Tab) or sibling (Enter) to the selected mind-map node. */
  addMindMapNode(kind: 'child' | 'sibling'): boolean {
    const c = this.c;
    const el = c.selected.length === 1 ? c.selected[0]! : null;
    if (!el?.mindmap) return false;
    const parentId = kind === 'child' ? el.id : el.mindmap.parent;
    if (!parentId) return false;
    const ids = { node: newId(), line: newId() };
    const gesture = gestureId('mindmap');
    if (!c.apply(addMindMapChild(c.board, parentId, ids, { createdBy: c.options.userId }), { gesture, select: [ids.node] })) return false;
    c.apply(mindMapLayoutOps(c.board, el.mindmap.root), { gesture });
    c.history.seal();
    c.startEditing(ids.node, 0);
    return true;
  }

  private finishCreate(start: Point, end: Point, square: boolean): void {
    const c = this.c;
    c.transient = {};
    const dragged = distance(start, end) * c.camera.zoom > DRAG_START * 2;
    const r = dragged ? this.createRect(start, end, square) : null;
    const at = this.placement(r ? { x: r.x, y: r.y } : start);
    let el: BoardElement;
    switch (c.tool) {
      case 'frame': {
        const box = r && r.w > 20 && r.h > 20 ? r : { x: start.x - 400, y: start.y - 300, w: 800, h: 600 };
        const count = [...c.board.elements.values()].filter((e) => e.type === 'frame').length;
        el = makeFrame(box.x, box.y, box.w, box.h, `Frame ${count + 1}`, this.placeAt());
        break;
      }
      case 'text': {
        el = makeText(r?.x ?? start.x, r?.y ?? start.y - 16, '', at, { w: r && r.w > 40 ? r.w : 280 });
        break;
      }
      case 'card':
        el = makeCard((r?.x ?? start.x - 150), r?.y ?? start.y - 70, '', at);
        if (r && r.w > 60) el = { ...el, w: r.w, h: Math.max(100, r.h) };
        break;
      default: {
        const kind = c.toolOptions.shape;
        const size = kind === 'rectangle' || kind === 'rounded' ? { w: 160, h: 100 } : { w: 120, h: 120 };
        const box = r && r.w > 4 && r.h > 4 ? r : { x: start.x - size.w / 2, y: start.y - size.h / 2, ...size };
        el = makeShape(kind, box.x, box.y, box.w, box.h, at, { fill: c.toolOptions.shapeFill });
      }
    }
    el.createdBy = c.options.userId;
    el.createdAt = Date.now();
    const gesture = gestureId('create');
    c.apply({ type: 'create', elements: [el] }, { gesture, select: [el.id] });
    if (el.type === 'frame') c.apply(adoptOps(c.board, el.id), { gesture });
    c.history.seal();
    c.toolDone();
    if (el.type === 'text' || el.type === 'card') c.startEditing(el.id, 0);
  }

  /** A connector end at `p`: bound to the element under it (its nearest side), else free. */
  private snapTarget(p: Point, skip: string | null): ConnectorEnd | null {
    const c = this.c;
    const hit = c.index.hit(p, 12 / c.camera.zoom, skip ? new Set([skip]) : undefined, (e) => isConnectable(e));
    if (!hit) return null;
    const side = facingSide(hit, p);
    const box = { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
    const nearCenter = distance(p, { x: box.x + box.w / 2, y: box.y + box.h / 2 }) < Math.min(box.w, box.h) * 0.25;
    return { x: p.x, y: p.y, el: hit.id, side: nearCenter ? 'auto' : side };
  }

  private previewConnector(drag: Extract<Drag, { kind: 'connector' }>): Point[] {
    const c = this.c;
    const end: ConnectorEnd = drag.target ?? { x: drag.current.x, y: drag.current.y };
    const existing = drag.existing ? c.board.get(drag.existing.id) : null;
    const fake: BoardElement = {
      id: '__preview',
      type: 'connector',
      order: 'a0',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      start: drag.existing?.which === 'start' ? end : drag.from,
      end: drag.existing?.which === 'start' ? drag.from : end,
      route: existing?.route ?? c.toolOptions.connectorRoute,
    };
    return connectorGeometry(c.board, fake).points;
  }

  private finishConnector(drag: Extract<Drag, { kind: 'connector' }>): void {
    const c = this.c;
    c.transient = {};
    const end: ConnectorEnd = drag.target ?? { x: drag.current.x, y: drag.current.y };
    if (drag.existing) {
      c.apply({ type: 'set', id: drag.existing.id, patch: { [drag.existing.which]: end } }, { gesture: drag.gesture });
      c.history.seal();
      c.changed();
      return;
    }
    const fromPoint = drag.from.el ? connectorGeometry(c.board, { id: '_', type: 'connector', order: 'a0', x: 0, y: 0, w: 0, h: 0, start: drag.from, end }).start.p : drag.from;
    if (distance(fromPoint, drag.current) * c.camera.zoom < 8 && !drag.target) {
      c.changed();
      return;
    }
    // From a shape's side handle into empty space: make a copy of the shape there, connected (Miro's quick connect).
    const elements: BoardElement[] = [];
    let endRef = end;
    const from = drag.from.el ? c.board.get(drag.from.el) : undefined;
    if (!drag.target && from && c.tool === 'select' && (from.type === 'shape' || from.type === 'sticky')) {
      const id = newId();
      const copy: BoardElement = { ...structuredClone(from), id, x: drag.current.x - from.w / 2, y: drag.current.y - from.h / 2, order: keyBetween(c.board.topOrder(c.board.effectiveParent(from)), null), createdBy: c.options.userId, createdAt: Date.now() };
      delete copy.text;
      delete copy.mindmap;
      delete copy.locked;
      elements.push(copy);
      endRef = { x: drag.current.x, y: drag.current.y, el: id, side: oppositeSide(drag.from.side) };
    }
    const conn = makeConnector(
      { ...drag.from, x: fromPoint.x, y: fromPoint.y },
      endRef,
      { order: keyBetween(c.board.topOrder(null), null), createdBy: c.options.userId, now: Date.now() },
      { route: c.toolOptions.connectorRoute, endCap: c.toolOptions.endCap },
    );
    elements.unshift(conn);
    const gesture = gestureId('connect');
    c.apply({ type: 'create', elements }, { gesture, select: [elements.length > 1 ? elements[1]!.id : conn.id] });
    c.history.seal();
    c.toolDone();
    if (elements.length > 1) c.startEditing(elements[1]!.id, 0);
  }

  private finishStroke(drag: Extract<Drag, { kind: 'stroke' }>): void {
    const c = this.c;
    c.transient = {};
    const pts = simplify(drag.points, 0.6 / c.camera.zoom);
    if (pts.length < 2) {
      c.changed();
      return;
    }
    const minX = Math.min(...pts.map((q) => q.x));
    const minY = Math.min(...pts.map((q) => q.y));
    const maxX = Math.max(...pts.map((q) => q.x));
    const maxY = Math.max(...pts.map((q) => q.y));
    const flat: number[] = [];
    pts.forEach((q, i) => flat.push(round(q.x - minX), round(q.y - minY), Math.round((drag.pressure[Math.min(i, drag.pressure.length - 1)] ?? 0.5) * 100) / 100));
    const highlighter = c.tool === 'highlighter';
    const at = this.placement({ x: minX, y: minY });
    const el: BoardElement = {
      id: newId(),
      type: 'pen',
      order: at.order,
      ...(at.parent ? { parent: at.parent } : {}),
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      points: flat.slice(0, 90_000),
      stroke: highlighter ? c.toolOptions.highlighterColor : c.toolOptions.penColor,
      strokeWidth: highlighter ? 16 : c.toolOptions.penWidth,
      ...(highlighter ? { pen: 'highlighter' as const } : {}),
      createdBy: c.options.userId,
      createdAt: Date.now(),
    };
    c.apply({ type: 'create', elements: [el] });
  }

  private eraseAt(p: Point, drag?: Extract<Drag, { kind: 'erase' }>): void {
    const c = this.c;
    const hit = c.index.hit(p, 8 / c.camera.zoom, undefined, (e) => e.type === 'pen' && !e.locked);
    if (hit && drag && !drag.erased.has(hit.id)) {
      drag.erased.add(hit.id);
      c.transient = { erasing: new Set(drag.erased) };
      c.changed(false);
    }
  }

  private pointInTextBox(el: BoardElement, p: Point): boolean {
    const local = el.rotation ? rotatePoint(p, { x: el.x + el.w / 2, y: el.y + el.h / 2 }, -el.rotation) : p;
    if (el.type === 'connector') return distance(local, connectorGeometry(this.c.board, el).label) < 60;
    return local.x >= el.x && local.x <= el.x + el.w && local.y >= el.y && local.y <= el.y + el.h;
  }

  /** The text offset under a board point, or null for an element without a text box. */
  private textOffsetAt(el: BoardElement, p: Point): number | null {
    const t = elementTextLayout(el, { measurer: this.c.measurer });
    if (!t) return null;
    const local = el.rotation ? rotatePoint(p, { x: el.x + el.w / 2, y: el.y + el.h / 2 }, -el.rotation) : p;
    return offsetAt(t.layout, local.x - t.x, local.y - t.y);
  }

  private resizeTo(drag: Extract<Drag, { kind: 'resize' }>, p: Point, info: PointerInfo): void {
    const c = this.c;
    const { startBox: b, rotation, handle } = drag;
    const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const local = rotatePoint(p, center, -rotation);
    let left = b.x;
    let top = b.y;
    let right = b.x + b.w;
    let bottom = b.y + b.h;
    if (handle.includes('w')) left = Math.min(local.x, right - 4);
    if (handle.includes('e')) right = Math.max(local.x, left + 4);
    if (handle.includes('n')) top = Math.min(local.y, bottom - 4);
    if (handle.includes('s')) bottom = Math.max(local.y, top + 4);
    let w = right - left;
    let h = bottom - top;
    const corner = handle.length === 2;
    if ((drag.keepRatio || info.shift) && corner && b.w > 0 && b.h > 0) {
      const scale = Math.max(w / b.w, h / b.h);
      w = b.w * scale;
      h = b.h * scale;
      if (handle.includes('w')) left = right - w;
      else right = left + w;
      if (handle.includes('n')) top = bottom - h;
      else bottom = top + h;
    }
    if (info.alt) {
      // Alt: resize from the centre.
      w = Math.abs(local.x - center.x) * (handle.includes('e') || handle.includes('w') ? 2 : 0) || w;
      h = Math.abs(local.y - center.y) * (handle.includes('n') || handle.includes('s') ? 2 : 0) || h;
      left = center.x - w / 2;
      top = center.y - h / 2;
    }
    // The new box's centre, rotated back.
    const newCenterLocal = { x: left + w / 2, y: top + h / 2 };
    const newCenter = rotatePoint(newCenterLocal, center, rotation);
    const nb = { x: newCenter.x - w / 2, y: newCenter.y - h / 2, w, h };
    const sx = b.w ? w / b.w : 1;
    const sy = b.h ? h / b.h : 1;
    const ops: Op[] = [];
    const single = drag.ids.length === 1 ? drag.origin.get(drag.ids[0]!) : undefined;
    if (single && single.type !== 'pen' && drag.origin.size === 1) {
      const patch: Record<string, unknown> = { x: nb.x, y: nb.y, w: Math.max(4, nb.w), h: Math.max(4, nb.h) };
      if (single.type === 'text' && corner && single.fontSize) patch.fontSize = Math.max(4, Math.round(single.fontSize * sy * 10) / 10);
      ops.push({ type: 'set', id: single.id, patch });
    } else {
      for (const [id, el] of drag.origin) {
        if (el.type === 'connector') {
          const patch: Record<string, unknown> = {};
          if (el.start && !el.start.el) patch.start = { ...el.start, x: nb.x + (el.start.x - b.x) * sx, y: nb.y + (el.start.y - b.y) * sy };
          if (el.end && !el.end.el) patch.end = { ...el.end, x: nb.x + (el.end.x - b.x) * sx, y: nb.y + (el.end.y - b.y) * sy };
          if (Object.keys(patch).length) ops.push({ type: 'set', id, patch });
          continue;
        }
        const patch: Record<string, unknown> = { x: nb.x + (el.x - b.x) * sx, y: nb.y + (el.y - b.y) * sy, w: Math.max(2, el.w * sx), h: Math.max(2, el.h * sy) };
        if (el.type === 'pen' && el.points) patch.points = el.points.map((v, i) => (i % 3 === 0 ? round(v * sx) : i % 3 === 1 ? round(v * sy) : v));
        if (el.type === 'text' && el.fontSize) patch.fontSize = Math.max(4, Math.round(el.fontSize * Math.min(sx, sy) * 10) / 10);
        ops.push({ type: 'set', id, patch });
      }
    }
    c.apply(batch(ops), { gesture: drag.gesture });
  }
}

function oppositeSide(side: ConnectorEnd['side']): Side | 'auto' {
  if (side === 'left') return 'right';
  if (side === 'right') return 'left';
  if (side === 'top') return 'bottom';
  if (side === 'bottom') return 'top';
  return 'auto';
}

function normalizeAngle(a: number): number {
  const two = Math.PI * 2;
  let r = a % two;
  if (r > Math.PI) r -= two;
  if (r < -Math.PI) r += two;
  return Math.abs(r) < 1e-4 ? 0 : Math.round(r * 10000) / 10000;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Ramer–Douglas–Peucker: drops points within `epsilon` of the line. */
function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let index = -1;
    const pa = points[a]!;
    const pb = points[b]!;
    for (let i = a + 1; i < b; i++) {
      const p = points[i]!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy) || 1;
      const d = Math.abs(dy * p.x - dx * p.y + pb.x * pa.y - pb.y * pa.x) / len;
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > epsilon && index > 0) {
      keep[index] = true;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

