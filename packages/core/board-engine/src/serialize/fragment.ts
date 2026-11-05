/**
 * Fragments: a selection of elements lifted off a board (copy, duplicate,
 * templates, imports) and put down on another place or board with fresh
 * ids. References between the elements (parents, connector ends, comment
 * targets, mind-map links) are kept; references to anything outside the
 * fragment are dropped.
 */

import { selectionBounds } from '../geometry/bounds';
import type { Board } from '../model/board';
import { newId } from '../model/defaults';
import { compareOrder, keysBetween } from '../model/order';
import { isElement } from '../model/schema';
import type { BoardElement, ConnectorEnd } from '../model/types';
import type { Op } from '../ops/types';

export const FRAGMENT_MIME = 'application/x-weldboard+json';
const FRAGMENT_TAG = 'weldboard-fragment';

export interface Fragment {
  kind: typeof FRAGMENT_TAG;
  version: 1;
  /** Elements with coordinates relative to the fragment's top-left. */
  elements: BoardElement[];
  width: number;
  height: number;
}

/** The fragment of the given elements, with their contents and the connectors between them. */
export function makeFragment(board: Board, ids: Iterable<string>): Fragment {
  const take = new Set<string>();
  for (const id of ids) {
    if (!board.get(id)) continue;
    take.add(id);
    for (const d of board.descendants(id)) take.add(d);
  }
  // Connectors whose both ends are bound inside the selection come along.
  for (const el of board.elements.values()) {
    if (el.type !== 'connector' || take.has(el.id)) continue;
    if (el.start?.el && el.end?.el && take.has(el.start.el) && take.has(el.end.el)) take.add(el.id);
  }
  const bounds = selectionBounds(board, take) ?? { x: 0, y: 0, w: 0, h: 0 };
  const els = board
    .paintOrder()
    .filter((e) => take.has(e.id))
    .map((e) => shift(structuredClone(e), -bounds.x, -bounds.y));
  return { kind: FRAGMENT_TAG, version: 1, elements: els, width: bounds.w, height: bounds.h };
}

function shiftEnd(end: ConnectorEnd | undefined, dx: number, dy: number): ConnectorEnd | undefined {
  return end ? { ...end, x: end.x + dx, y: end.y + dy } : end;
}

function shift(el: BoardElement, dx: number, dy: number): BoardElement {
  el.x += dx;
  el.y += dy;
  if (el.start) el.start = shiftEnd(el.start, dx, dy);
  if (el.end) el.end = shiftEnd(el.end, dx, dy);
  if (el.control) el.control = { x: el.control.x + dx, y: el.control.y + dy };
  return el;
}

export interface PlaceOptions {
  /** Where the fragment's top-left goes. */
  x: number;
  y: number;
  /** Parent for the top-level elements of the fragment (a frame), or the board's top level. */
  parent?: string | null;
  createdBy?: string;
  now?: number;
  makeId?: () => string;
}

/** A `create` op putting the fragment on the board, and the new ids of its top-level elements. */
export function placeFragment(board: Board, fragment: Fragment, options: PlaceOptions): { op: Op; ids: string[]; all: string[] } {
  const makeId = options.makeId ?? (() => newId());
  const map = new Map<string, string>();
  for (const el of fragment.elements) map.set(el.id, makeId());
  const parent = options.parent ?? null;
  const inside = new Set(fragment.elements.map((e) => e.id));
  const topLevel = fragment.elements.filter((e) => !e.parent || !inside.has(e.parent));
  const keys = keysBetween(board.topOrder(parent), null, topLevel.length);
  const topKey = new Map(topLevel.map((e, i) => [e.id, keys[i]!]));

  const remapEnd = (end: ConnectorEnd | undefined): ConnectorEnd | undefined => {
    if (!end) return end;
    const out: ConnectorEnd = { ...end, x: end.x + options.x, y: end.y + options.y };
    if (end.el) {
      const id = map.get(end.el);
      if (id) out.el = id;
      else {
        delete out.el;
        delete out.side;
        delete out.rx;
        delete out.ry;
      }
    }
    return out;
  };

  const elements: BoardElement[] = [];
  for (const src of fragment.elements) {
    const el = shift(structuredClone(src), options.x, options.y);
    el.id = map.get(src.id)!;
    const inFragment = src.parent && inside.has(src.parent);
    if (inFragment) el.parent = map.get(src.parent!)!;
    else if (parent) el.parent = parent;
    else delete el.parent;
    if (topKey.has(src.id)) el.order = topKey.get(src.id)!;
    if (src.start) el.start = remapEnd({ ...src.start, x: src.start.x, y: src.start.y });
    if (src.end) el.end = remapEnd({ ...src.end, x: src.end.x, y: src.end.y });
    if (src.target) {
      const t = map.get(src.target);
      if (t) el.target = t;
      else delete el.target;
    }
    if (src.mindmap) {
      const root = map.get(src.mindmap.root);
      if (!root) delete el.mindmap;
      else el.mindmap = { ...src.mindmap, root, ...(src.mindmap.parent ? { parent: map.get(src.mindmap.parent) ?? root } : {}) };
      if (el.mindmap && el.mindmap.parent === el.id) delete el.mindmap.parent;
    }
    if (el.type === 'comment') continue; // Comment threads belong to the board they were made on.
    if (options.createdBy) el.createdBy = options.createdBy;
    if (options.now !== undefined) el.createdAt = options.now;
    elements.push(el);
  }
  // Parents before children: children of a fragment frame keep their relative order.
  elements.sort((a, b) => depthOf(a, elements) - depthOf(b, elements) || compareOrder(a, b));
  return {
    op: { type: 'create', elements },
    ids: topLevel.map((e) => map.get(e.id)!).filter((id) => elements.some((e) => e.id === id)),
    all: elements.map((e) => e.id),
  };
}

function depthOf(el: BoardElement, all: BoardElement[]): number {
  let depth = 0;
  let current: BoardElement | undefined = el;
  for (let guard = 0; current?.parent && guard < 100; guard++) {
    depth++;
    const p: string = current.parent;
    current = all.find((e) => e.id === p);
  }
  return depth;
}

export function isFragment(v: unknown): v is Fragment {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    f.kind === FRAGMENT_TAG &&
    f.version === 1 &&
    Array.isArray(f.elements) &&
    f.elements.length <= 10_000 &&
    f.elements.every(isElement) &&
    typeof f.width === 'number' &&
    typeof f.height === 'number'
  );
}

/** Text for the system clipboard: the fragment, readable as JSON, recognisable when pasted back. */
export function fragmentToText(fragment: Fragment): string {
  return JSON.stringify(fragment);
}

export function fragmentFromText(text: string): Fragment | null {
  if (!text.includes(FRAGMENT_TAG)) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return isFragment(v) ? v : null;
  } catch {
    return null;
  }
}
