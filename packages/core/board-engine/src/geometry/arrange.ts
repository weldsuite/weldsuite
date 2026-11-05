/**
 * Builders for the ops behind arrange commands: align, distribute, stacking
 * order, grouping, frames taking in what is dropped on them, moving with
 * contents, and deleting with contents.
 *
 * Each returns an op made against the current board; the editor applies it
 * through the controller (one undo step).
 */

import type { Board } from '../model/board';
import { keyBetween, keysBetween } from '../model/order';
import type { BoardElement, ConnectorEnd } from '../model/types';
import { batch, NOOP, type Op } from '../ops/types';
import { elementBounds, selectionBounds } from './bounds';
import { connectorGeometry } from './connectors';
import { rectContains, type Point, type Rect } from './path';

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/** Elements a command acts on: the ones given, without connectors (they follow) and without locked ones. */
function movable(board: Board, ids: Iterable<string>): BoardElement[] {
  const out: BoardElement[] = [];
  for (const id of ids) {
    const el = board.get(id);
    if (el && !el.locked && el.type !== 'connector') out.push(el);
  }
  return out;
}

/**
 * Moves elements (and, for a frame or group, everything inside) by (dx, dy).
 * A connector moved on its own lets go of elements that stay put; one
 * moving with what it is bound to keeps its bindings.
 */
export function moveOps(board: Board, ids: Iterable<string>, dx: number, dy: number): Op {
  if (dx === 0 && dy === 0) return NOOP;
  const direct = new Set(ids);
  const all = new Set<string>();
  for (const id of direct) {
    all.add(id);
    const el = board.get(id);
    if (el && (el.type === 'frame' || el.type === 'group')) for (const d of board.descendants(id)) all.add(d);
  }
  const ops: Op[] = [];
  for (const id of all) {
    const el = board.get(id);
    if (!el) continue;
    if (el.type !== 'connector') {
      ops.push({ type: 'set', id, patch: { x: el.x + dx, y: el.y + dy } });
      continue;
    }
    const g = connectorGeometry(board, el);
    const shift = (end: ConnectorEnd | undefined, at: Point): ConnectorEnd | undefined => {
      if (!end) return end;
      const bound = end.el && board.get(end.el);
      if (bound && !all.has(end.el!) && direct.has(id)) return { x: at.x + dx, y: at.y + dy };
      return { ...end, x: at.x + dx, y: at.y + dy };
    };
    const patch: Record<string, unknown> = { x: el.x + dx, y: el.y + dy };
    if (el.start) patch.start = shift(el.start, g.start.p);
    if (el.end) patch.end = shift(el.end, g.end.p);
    if (el.control) patch.control = { x: el.control.x + dx, y: el.control.y + dy };
    ops.push({ type: 'set', id, patch });
  }
  return batch(ops);
}

export function alignOps(board: Board, ids: Iterable<string>, mode: AlignMode): Op {
  const els = movable(board, ids);
  if (els.length < 2) return NOOP;
  const box = selectionBounds(board, els.map((e) => e.id))!;
  const ops: Op[] = [];
  for (const el of els) {
    const b = elementBounds(board, el);
    let dx = 0;
    let dy = 0;
    if (mode === 'left') dx = box.x - b.x;
    if (mode === 'center') dx = box.x + box.w / 2 - (b.x + b.w / 2);
    if (mode === 'right') dx = box.x + box.w - (b.x + b.w);
    if (mode === 'top') dy = box.y - b.y;
    if (mode === 'middle') dy = box.y + box.h / 2 - (b.y + b.h / 2);
    if (mode === 'bottom') dy = box.y + box.h - (b.y + b.h);
    ops.push(moveOps(board, [el.id], dx, dy));
  }
  return batch(ops);
}

export function distributeOps(board: Board, ids: Iterable<string>, axis: 'x' | 'y'): Op {
  const els = movable(board, ids);
  if (els.length < 3) return NOOP;
  const items = els.map((el) => ({ el, b: elementBounds(board, el) })).sort((a, b) => (axis === 'x' ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = items[0]!.b;
  const last = items[items.length - 1]!.b;
  const span = axis === 'x' ? last.x + last.w - first.x : last.y + last.h - first.y;
  const used = items.reduce((n, i) => n + (axis === 'x' ? i.b.w : i.b.h), 0);
  const gap = (span - used) / (items.length - 1);
  let pos = axis === 'x' ? first.x : first.y;
  const ops: Op[] = [];
  for (const { el, b } of items) {
    const current = axis === 'x' ? b.x : b.y;
    ops.push(axis === 'x' ? moveOps(board, [el.id], pos - current, 0) : moveOps(board, [el.id], 0, pos - current));
    pos += (axis === 'x' ? b.w : b.h) + gap;
  }
  return batch(ops);
}

/** Puts elements on top of (or under) their siblings, keeping their order among themselves. */
export function stackOps(board: Board, ids: Iterable<string>, where: 'front' | 'back' | 'forward' | 'backward'): Op {
  const byParent = new Map<string | null, BoardElement[]>();
  for (const id of ids) {
    const el = board.get(id);
    if (!el) continue;
    const p = board.effectiveParent(el);
    let list = byParent.get(p);
    if (!list) byParent.set(p, (list = []));
    list.push(el);
  }
  const ops: Op[] = [];
  for (const [parent, els] of byParent) {
    const siblings = board.childIds(parent).map((id) => board.get(id)!);
    const moving = new Set(els.map((e) => e.id));
    const ordered = siblings.filter((s) => moving.has(s.id));
    const rest = siblings.filter((s) => !moving.has(s.id));
    let keys: string[];
    if (where === 'front') keys = keysBetween(rest.at(-1)?.order ?? null, null, ordered.length);
    else if (where === 'back') keys = keysBetween(null, rest[0]?.order ?? null, ordered.length);
    else {
      // One step: past the next sibling that overlaps nothing in particular, i.e. the next one in the list.
      const firstIndex = siblings.findIndex((s) => moving.has(s.id));
      const lastIndex = siblings.length - 1 - [...siblings].reverse().findIndex((s) => moving.has(s.id));
      if (where === 'forward') {
        const after = siblings.slice(lastIndex + 1).find((s) => !moving.has(s.id));
        if (!after) continue;
        const next = siblings.slice(siblings.indexOf(after) + 1).find((s) => !moving.has(s.id));
        keys = keysBetween(after.order, next && next.order > after.order ? next.order : null, ordered.length);
      } else {
        const before = [...siblings.slice(0, firstIndex)].reverse().find((s) => !moving.has(s.id));
        if (!before) continue;
        const prevIndex = siblings.indexOf(before);
        const prev = [...siblings.slice(0, prevIndex)].reverse().find((s) => !moving.has(s.id));
        keys = keysBetween(prev && prev.order < before.order ? prev.order : null, before.order, ordered.length);
      }
    }
    ordered.forEach((el, i) => ops.push({ type: 'set', id: el.id, patch: { order: keys[i]! } }));
  }
  return batch(ops);
}

/** Wraps elements in a new group (returned with the op). */
export function groupOps(board: Board, ids: string[], groupId: string): Op {
  const els = ids.map((id) => board.get(id)).filter((e): e is BoardElement => !!e);
  if (els.length < 2) return NOOP;
  const box = selectionBounds(board, ids)!;
  const parent = board.effectiveParent(els[0]!);
  const group: BoardElement = {
    id: groupId,
    type: 'group',
    order: keyBetween(board.topOrder(parent), null),
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    ...(parent ? { parent } : {}),
  };
  const ordered = [...els].sort((a, b) => (a.order < b.order ? -1 : 1));
  const keys = keysBetween(null, null, ordered.length);
  return batch([
    { type: 'create', elements: [group] },
    ...ordered.map((el, i): Op => ({ type: 'set', id: el.id, patch: { parent: groupId, order: keys[i]! } })),
  ]);
}

export function ungroupOps(board: Board, groupId: string): Op {
  const group = board.get(groupId);
  if (!group || group.type !== 'group') return NOOP;
  const parent = board.effectiveParent(group);
  const children = board.childIds(groupId);
  const keys = keysBetween(board.topOrder(parent), null, children.length);
  return batch([
    ...children.map((id, i): Op => ({ type: 'set', id, patch: { parent: parent ?? null, order: keys[i]! } })),
    { type: 'delete', ids: [groupId] },
  ]);
}

/** Recomputes a group's box from its children (after they moved or resized). */
export function fitGroupOps(board: Board, groupId: string): Op {
  const group = board.get(groupId);
  if (!group || group.type !== 'group') return NOOP;
  const box = selectionBounds(board, board.childIds(groupId));
  if (!box) return { type: 'delete', ids: [groupId] };
  if (box.x === group.x && box.y === group.y && box.w === group.w && box.h === group.h) return NOOP;
  return { type: 'set', id: groupId, patch: { x: box.x, y: box.y, w: box.w, h: box.h } };
}

/**
 * After a move: each moved top-level element that now lies inside a frame
 * joins it, and one that left its frame goes back to the frame's parent.
 */
export function reparentOps(board: Board, ids: Iterable<string>): Op {
  const frames = board.paintOrder().filter((e) => e.type === 'frame');
  const ops: Op[] = [];
  const moved = new Set(ids);
  for (const id of moved) {
    const el = board.get(id);
    if (!el || el.type === 'frame' || el.type === 'connector') continue;
    const current = board.effectiveParent(el);
    const currentEl = current ? board.get(current) : undefined;
    if (currentEl?.type === 'group') continue;
    const b = elementBounds(board, el);
    // The topmost frame fully containing the element (frames can nest).
    let target: BoardElement | null = null;
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      if (f.id === id || moved.has(f.id) || board.isInside(f.id, id)) continue;
      if (rectContains({ x: f.x, y: f.y, w: f.w, h: f.h }, b)) {
        target = f;
        break;
      }
    }
    const next = target?.id ?? null;
    if (next === current) continue;
    ops.push({ type: 'set', id, patch: { parent: next, order: keyBetween(board.topOrder(next), null) } });
  }
  return batch(ops);
}

/** Every element a frame newly covers joins it (after the frame is drawn or resized). */
export function adoptOps(board: Board, frameId: string): Op {
  const frame = board.get(frameId);
  if (!frame || frame.type !== 'frame') return NOOP;
  const box: Rect = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  const parent = board.effectiveParent(frame);
  const ops: Op[] = [];
  let top = board.topOrder(frameId);
  for (const id of board.childIds(parent)) {
    const el = board.get(id);
    if (!el || el.id === frameId || el.type === 'connector' || el.type === 'frame') continue;
    if (!rectContains(box, elementBounds(board, el))) continue;
    const order = keyBetween(top, null);
    top = order;
    ops.push({ type: 'set', id, patch: { parent: frameId, order } });
  }
  // And what left it goes back out.
  for (const id of board.childIds(frameId)) {
    const el = board.get(id);
    if (!el || el.type === 'connector') continue;
    if (rectContains(box, elementBounds(board, el))) continue;
    ops.push({ type: 'set', id, patch: { parent: parent ?? null } });
  }
  return batch(ops);
}

/** Deletes elements with everything inside them, and unbinds connectors from what goes. */
export function deleteOps(board: Board, ids: Iterable<string>): Op {
  const all = new Set<string>();
  for (const id of ids) {
    if (!board.get(id)) continue;
    all.add(id);
    for (const d of board.descendants(id)) all.add(d);
  }
  // Comment pins on deleted elements go too.
  for (const el of board.elements.values()) if (el.type === 'comment' && el.target && all.has(el.target)) all.add(el.id);
  if (all.size === 0) return NOOP;
  const ops: Op[] = [];
  for (const el of board.elements.values()) {
    if (el.type !== 'connector' || all.has(el.id)) continue;
    const startGone = !!el.start?.el && all.has(el.start.el);
    const endGone = !!el.end?.el && all.has(el.end.el);
    if (!startGone && !endGone) continue;
    // Keep the end where it is drawn now.
    const g = connectorGeometry(board, el);
    const patch: Record<string, unknown> = {};
    if (startGone) patch.start = { x: g.start.p.x, y: g.start.p.y };
    if (endGone) patch.end = { x: g.end.p.x, y: g.end.p.y };
    ops.push({ type: 'set', id: el.id, patch });
  }
  ops.push({ type: 'delete', ids: [...all] });
  return batch(ops);
}
