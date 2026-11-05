/**
 * Board specs: a plain description of things to put on a board (sticky notes,
 * shapes, text, cards, frames, the lines between them, a mind map), for the
 * callers that do not draw: the AI actions, the WeldAgent board tools and the
 * public API. They say what goes on the board; `fragmentFromSpec` decides
 * where, and `placeSpec` puts the result next to what is already there.
 *
 * Input is trusted for shape only: callers validate the JSON (the Zod schema
 * in @weldsuite/app-api-client/schemas/boards), and everything here is
 * clamped again (lengths, counts, depth, colours, shape kinds), so a spec can
 * never make an op the room refuses.
 */

import type { Board } from '../model/board';
import { STICKY_COLORS, STICKY_SIZE, newId } from '../model/defaults';
import { keysBetween } from '../model/order';
import { plain } from '../model/text';
import { SHAPE_KINDS, type BoardElement, type ConnectorEnd, type ShapeKind } from '../model/types';
import { selectionBounds } from '../geometry/bounds';
import { deleteOps, moveOps } from '../geometry/arrange';
import { batch, NOOP, type Op } from '../ops/types';
import { placeFragment, type Fragment } from './fragment';

/** The colours a spec may name. Sticky notes take the sticky shade, shapes and cards a light fill. */
export const SPEC_COLORS = ['yellow', 'orange', 'red', 'pink', 'violet', 'blue', 'cyan', 'teal', 'green', 'lime', 'grey', 'white'] as const;
export type SpecColor = (typeof SPEC_COLORS)[number];

const STICKY_SHADE: Record<SpecColor, string> = {
  yellow: STICKY_COLORS[0],
  orange: STICKY_COLORS[10],
  red: STICKY_COLORS[12],
  pink: STICKY_COLORS[8],
  violet: STICKY_COLORS[11],
  blue: STICKY_COLORS[5],
  cyan: STICKY_COLORS[6],
  teal: STICKY_COLORS[4],
  green: STICKY_COLORS[3],
  lime: STICKY_COLORS[2],
  grey: STICKY_COLORS[13],
  white: STICKY_COLORS[14],
};

const LIGHT_FILL: Record<SpecColor, string> = {
  yellow: '#fef9c3',
  orange: '#ffedd5',
  red: '#fee2e2',
  pink: '#fce7f3',
  violet: '#ede9fe',
  blue: '#dbeafe',
  cyan: '#cffafe',
  teal: '#ccfbf1',
  green: '#dcfce7',
  lime: '#ecfccb',
  grey: '#f3f4f6',
  white: '#ffffff',
};

export const SPEC_ITEM_TYPES = ['sticky', 'shape', 'text', 'card'] as const;
export type SpecItemType = (typeof SPEC_ITEM_TYPES)[number];

export interface SpecItem {
  /** A name for the item, unique in the spec, for lines to refer to. */
  key?: string;
  type: SpecItemType;
  text: string;
  /** For a shape: its kind (default a rounded rectangle). */
  shape?: ShapeKind;
  color?: SpecColor;
  /** For a card: the text under its title. */
  description?: string;
  /** The key of the frame the item goes in. */
  frame?: string;
}

export interface SpecFrame {
  key: string;
  title: string;
}

export interface SpecLine {
  from: string;
  to: string;
  label?: string;
}

export interface SpecMindNode {
  text: string;
  children?: SpecMindNode[];
}

export interface BoardSpec {
  /**
   * How items are arranged: `grid` rows of notes, `flow` layers that follow
   * the lines (a flowchart). Default: `flow` when there are lines, else `grid`.
   */
  layout?: 'grid' | 'flow';
  /** Which way a flow runs (default down). */
  direction?: 'down' | 'right';
  items?: SpecItem[];
  /** Frames, laid out side by side, each holding its items in a grid. */
  frames?: SpecFrame[];
  lines?: SpecLine[];
  /** A mind map: the root and its branches. */
  mindmap?: SpecMindNode;
}

/** Most items, frames and lines one spec may make, and most mind-map nodes. */
export const SPEC_LIMITS = { items: 500, frames: 50, lines: 1000, mindNodes: 300, mindDepth: 6, text: 2000 } as const;

const GAP = 40;
const FRAME_PAD = 48;
const FRAME_TITLE = 32;
const MIND_H_GAP = 80;
const MIND_V_GAP = 24;

const clip = (text: unknown, max: number = SPEC_LIMITS.text) => (typeof text === 'string' ? text.replace(/\r\n?/g, '\n').slice(0, max) : '');
const colorOf = (c: unknown): SpecColor | undefined => (SPEC_COLORS as readonly string[]).includes(c as string) ? (c as SpecColor) : undefined;
const shapeOf = (s: unknown): ShapeKind => ((SHAPE_KINDS as readonly string[]).includes(s as string) ? (s as ShapeKind) : 'rounded');

function sizeOf(item: SpecItem): { w: number; h: number } {
  switch (item.type) {
    case 'sticky':
      return { w: STICKY_SIZE, h: STICKY_SIZE };
    case 'text':
      return { w: 320, h: Math.max(34, Math.ceil(item.text.length / 28) * 34) };
    case 'card':
      return { w: 300, h: 140 };
    case 'shape':
      return item.shape === 'diamond' ? { w: 220, h: 140 } : item.shape === 'ellipse' || item.shape === 'terminator' ? { w: 220, h: 100 } : { w: 220, h: 110 };
  }
}

function itemElement(item: SpecItem, id: string, x: number, y: number, order: string, parent?: string): BoardElement {
  const { w, h } = sizeOf(item);
  const color = item.color;
  const base: BoardElement = { id, type: item.type, order, x, y, w, h, ...(parent ? { parent } : {}) };
  switch (item.type) {
    case 'sticky':
      return { ...base, fill: STICKY_SHADE[color ?? 'yellow'], text: plain(item.text), fontSize: 22, textAlign: 'center', vAlign: 'middle', autoFit: true };
    case 'text':
      return { ...base, text: plain(item.text), fontSize: 20, textAlign: 'left', vAlign: 'top' };
    case 'card':
      return {
        ...base,
        text: plain(item.text),
        fill: '#ffffff',
        stroke: '#3b82f6',
        fontSize: 16,
        textAlign: 'left',
        vAlign: 'top',
        ...(item.description ? { description: item.description } : {}),
      };
    case 'shape':
      return {
        ...base,
        shape: item.shape ?? 'rounded',
        fill: LIGHT_FILL[color ?? 'white'],
        stroke: '#1f2937',
        strokeWidth: 2,
        text: plain(item.text),
        fontSize: 16,
        textAlign: 'center',
        vAlign: 'middle',
      };
  }
}

/** The spec with every list clamped, every text cut, unknown colours and shapes dropped and duplicate keys renamed. */
export function normalizeSpec(raw: BoardSpec): BoardSpec {
  const keys = new Set<string>();
  const uniqueKey = (key: unknown): string | undefined => {
    if (typeof key !== 'string' || !key.trim()) return undefined;
    let k = key.trim().slice(0, 100);
    for (let n = 2; keys.has(k); n++) k = `${key.trim().slice(0, 95)}~${n}`;
    keys.add(k);
    return k;
  };
  const frames = (Array.isArray(raw.frames) ? raw.frames : []).slice(0, SPEC_LIMITS.frames).flatMap((f) => {
    const key = uniqueKey(f?.key);
    return key ? [{ key, title: clip(f.title, 200) }] : [];
  });
  const frameKeys = new Set(frames.map((f) => f.key));
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, SPEC_LIMITS.items).flatMap((it): SpecItem[] => {
    if (!it || !(SPEC_ITEM_TYPES as readonly string[]).includes(it.type)) return [];
    const key = uniqueKey(it.key);
    const color = colorOf(it.color);
    return [
      {
        type: it.type,
        text: clip(it.text),
        ...(key ? { key } : {}),
        ...(it.type === 'shape' ? { shape: shapeOf(it.shape) } : {}),
        ...(color ? { color } : {}),
        ...(it.type === 'card' && it.description ? { description: clip(it.description, 5000) } : {}),
        ...(typeof it.frame === 'string' && frameKeys.has(it.frame) ? { frame: it.frame } : {}),
      },
    ];
  });
  const itemKeys = new Set(items.flatMap((i) => (i.key ? [i.key] : [])));
  const lines = (Array.isArray(raw.lines) ? raw.lines : [])
    .filter((l) => l && itemKeys.has(l.from) && itemKeys.has(l.to) && l.from !== l.to)
    .slice(0, SPEC_LIMITS.lines)
    .map((l) => ({ from: l.from, to: l.to, ...(l.label ? { label: clip(l.label, 200) } : {}) }));
  let budget: number = SPEC_LIMITS.mindNodes;
  const mind = (node: SpecMindNode | undefined, depth: number): SpecMindNode | undefined => {
    if (!node || budget <= 0) return undefined;
    budget--;
    const children = depth < SPEC_LIMITS.mindDepth && Array.isArray(node.children) ? node.children.flatMap((c) => mind(c, depth + 1) ?? []) : [];
    return { text: clip(node.text, 300), ...(children.length ? { children } : {}) };
  };
  const mindmap = mind(raw.mindmap, 1);
  return {
    ...(raw.layout === 'grid' || raw.layout === 'flow' ? { layout: raw.layout } : {}),
    ...(raw.direction === 'down' || raw.direction === 'right' ? { direction: raw.direction } : {}),
    ...(items.length ? { items } : {}),
    ...(frames.length ? { frames } : {}),
    ...(lines.length ? { lines } : {}),
    ...(mindmap ? { mindmap } : {}),
  };
}

/** How many elements the spec makes (items, frames, lines, mind-map nodes and their lines). */
export function specSize(spec: BoardSpec): number {
  let mind = 0;
  const count = (n: SpecMindNode | undefined) => {
    if (!n) return;
    mind++;
    n.children?.forEach(count);
  };
  count(spec.mindmap);
  return (spec.items?.length ?? 0) + (spec.frames?.length ?? 0) + (spec.lines?.length ?? 0) + Math.max(0, mind * 2 - 1);
}

interface Box {
  item: SpecItem;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Items in rows, `perRow` to a row, from (x, y); each row as tall as its tallest item. */
function grid(items: SpecItem[], ids: Map<SpecItem, string>, x: number, y: number, perRow: number): { boxes: Box[]; w: number; h: number } {
  const boxes: Box[] = [];
  let rowY = y;
  let width = 0;
  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow);
    let cx = x;
    let rowH = 0;
    for (const item of row) {
      const { w, h } = sizeOf(item);
      boxes.push({ item, id: ids.get(item)!, x: cx, y: rowY, w, h });
      cx += w + GAP;
      rowH = Math.max(rowH, h);
    }
    width = Math.max(width, cx - GAP - x);
    rowY += rowH + GAP;
  }
  return { boxes, w: Math.max(0, width), h: Math.max(0, rowY - GAP - y) };
}

const perRowFor = (n: number) => Math.max(1, Math.min(6, Math.ceil(Math.sqrt(n))));

/** Layers along the lines: each item one past the furthest item leading to it (cycles cut). */
function flow(items: SpecItem[], lines: SpecLine[], ids: Map<SpecItem, string>, direction: 'down' | 'right'): Box[] {
  const byKey = new Map(items.flatMap((i) => (i.key ? [[i.key, i] as const] : [])));
  const layer = new Map<SpecItem, number>(items.map((i) => [i, 0]));
  // Longest-path layering, at most items.length passes so a cycle cannot loop.
  for (let pass = 0; pass < items.length; pass++) {
    let changed = false;
    for (const l of lines) {
      const a = byKey.get(l.from);
      const b = byKey.get(l.to);
      if (!a || !b) continue;
      const next = layer.get(a)! + 1;
      if (next > layer.get(b)! && next < items.length) {
        layer.set(b, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const layers: SpecItem[][] = [];
  for (const item of items) (layers[layer.get(item)!] ??= []).push(item);
  const rows = layers.filter(Boolean);
  const across = (row: SpecItem[]) => row.reduce((n, i) => n + (direction === 'down' ? sizeOf(i).w : sizeOf(i).h), 0) + (row.length - 1) * GAP * 2;
  const widest = Math.max(...rows.map(across));
  const boxes: Box[] = [];
  let along = 0;
  for (const row of rows) {
    let pos = (widest - across(row)) / 2;
    let depth = 0;
    for (const item of row) {
      const { w, h } = sizeOf(item);
      const x = direction === 'down' ? pos : along;
      const y = direction === 'down' ? along : pos;
      boxes.push({ item, id: ids.get(item)!, x, y, w, h });
      pos += (direction === 'down' ? w : h) + GAP * 2;
      depth = Math.max(depth, direction === 'down' ? h : w);
    }
    along += depth + GAP * 2.5;
  }
  return boxes;
}

const center = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** A mind map: the root at (0, 0), its branches split right and left, laid out as a horizontal tree. */
function mindMapElements(root: SpecMindNode, makeId: () => string): BoardElement[] {
  interface Node {
    id: string;
    text: string;
    w: number;
    h: number;
    side: 'left' | 'right';
    parent?: Node;
    kids: Node[];
    x: number;
    y: number;
  }
  const build = (n: SpecMindNode, side: 'left' | 'right', parent?: Node): Node => {
    const isRoot = !parent;
    const node: Node = { id: makeId(), text: n.text, w: isRoot ? 240 : 180, h: isRoot ? 72 : 56, side, kids: [], x: 0, y: 0, ...(parent ? { parent } : {}) };
    const kids = n.children ?? [];
    node.kids = kids.map((c, i) => build(c, isRoot ? (kids.length > 3 && i >= Math.ceil(kids.length / 2) ? 'left' : 'right') : side, node));
    return node;
  };
  const tree = build(root, 'right');
  const height = (n: Node, kids: Node[] = n.kids): number => Math.max(n.h, kids.reduce((s, k) => s + height(k), 0) + Math.max(0, kids.length - 1) * MIND_V_GAP);
  const place = (n: Node, kids: Node[], side: 'left' | 'right') => {
    const total = kids.reduce((s, k) => s + height(k), 0) + Math.max(0, kids.length - 1) * MIND_V_GAP;
    let y = n.y + n.h / 2 - total / 2;
    for (const k of kids) {
      const h = height(k);
      k.x = side === 'right' ? n.x + n.w + MIND_H_GAP : n.x - MIND_H_GAP - k.w;
      k.y = y + h / 2 - k.h / 2;
      place(k, k.kids, side);
      y += h + MIND_V_GAP;
    }
  };
  place(tree, tree.kids.filter((k) => k.side === 'right'), 'right');
  place(tree, tree.kids.filter((k) => k.side === 'left'), 'left');

  const out: BoardElement[] = [];
  const all: Node[] = [];
  const walk = (n: Node) => {
    all.push(n);
    n.kids.forEach(walk);
  };
  walk(tree);
  const keys = keysBetween(null, null, all.length * 2);
  let k = 0;
  for (const n of all) {
    if (n.parent) {
      const p = n.parent;
      const right = n.side === 'right';
      const start: ConnectorEnd = { x: right ? p.x + p.w : p.x, y: p.y + p.h / 2, el: p.id, side: right ? 'right' : 'left' };
      const end: ConnectorEnd = { x: right ? n.x : n.x + n.w, y: n.y + n.h / 2, el: n.id, side: right ? 'left' : 'right' };
      out.push({
        id: makeId(),
        type: 'connector',
        order: keys[k++]!,
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        w: Math.abs(end.x - start.x),
        h: Math.abs(end.y - start.y),
        start,
        end,
        route: 'curved',
        startCap: 'none',
        endCap: 'none',
        stroke: '#94a3b8',
        strokeWidth: 2,
      });
    }
    out.push({
      id: n.id,
      type: 'shape',
      shape: 'rounded',
      order: keys[k++]!,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      fill: n.parent ? '#ffffff' : '#dbeafe',
      stroke: n.parent ? '#1f2937' : '#3b82f6',
      strokeWidth: 2,
      text: plain(n.text),
      fontSize: n.parent ? 16 : 20,
      textAlign: 'center',
      vAlign: 'middle',
      mindmap: n.parent ? { root: tree.id, parent: n.parent.id, ...(n.parent === tree ? { side: n.side } : {}) } : { root: tree.id },
    });
  }
  return out;
}

function toFragment(elements: BoardElement[]): Fragment {
  if (!elements.length) return { kind: 'weldboard-fragment', version: 1, elements: [], width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    if (el.type === 'connector') continue;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  if (minX === Infinity) minX = minY = maxX = maxY = 0;
  for (const el of elements) {
    el.x -= minX;
    el.y -= minY;
    if (el.start) el.start = { ...el.start, x: el.start.x - minX, y: el.start.y - minY };
    if (el.end) el.end = { ...el.end, x: el.end.x - minX, y: el.end.y - minY };
  }
  return { kind: 'weldboard-fragment', version: 1, elements, width: maxX - minX, height: maxY - minY };
}

/**
 * The spec laid out as a fragment (coordinates from its top-left). Also the
 * id each keyed item got, for callers that report what they made.
 */
export function fragmentFromSpec(raw: BoardSpec, makeId: () => string = () => newId()): { fragment: Fragment; keys: Record<string, string> } {
  const spec = normalizeSpec(raw);
  const items = spec.items ?? [];
  const frames = spec.frames ?? [];
  const lines = spec.lines ?? [];
  const ids = new Map(items.map((i) => [i, makeId()]));
  const elements: BoardElement[] = [];
  const boxes: Box[] = [];
  let cursorX = 0;

  if (spec.mindmap) {
    const mind = mindMapElements(spec.mindmap, makeId);
    const bounds = mind.filter((e) => e.type !== 'connector');
    const minX = Math.min(...bounds.map((e) => e.x));
    const maxX = Math.max(...bounds.map((e) => e.x + e.w));
    for (const el of mind) {
      el.x -= minX;
      if (el.start) el.start = { ...el.start, x: el.start.x - minX };
      if (el.end) el.end = { ...el.end, x: el.end.x - minX };
    }
    elements.push(...mind);
    cursorX = maxX - minX + GAP * 4;
  }

  // Frames side by side, each with its items in a grid. Top-level order is
  // the array's: placeFragment re-keys the top level in that order.
  const frameKeys = keysBetween(null, null, frames.length || 1);
  let frameK = 0;
  for (const frame of frames) {
    const inside = items.filter((i) => i.frame === frame.key);
    const frameId = makeId();
    const laid = grid(inside, ids, cursorX + FRAME_PAD, FRAME_PAD + FRAME_TITLE, inside.length > 4 ? 2 : 1);
    const w = Math.max(320, laid.w + FRAME_PAD * 2);
    const h = Math.max(240, laid.h + FRAME_PAD * 2 + FRAME_TITLE);
    elements.push({ id: frameId, type: 'frame', order: frameKeys[frameK++]!, x: cursorX, y: 0, w, h, name: frame.title || 'Frame', fill: '#ffffff' });
    const childKeys = keysBetween(null, null, laid.boxes.length || 1);
    laid.boxes.forEach((b, i) => {
      boxes.push(b);
      elements.push(itemElement(b.item, b.id, b.x, b.y, childKeys[i]!, frameId));
    });
    cursorX += w + GAP * 2;
  }

  // Items in no frame: a flow along the lines, or a grid.
  const loose = items.filter((i) => !i.frame);
  if (loose.length) {
    const useFlow = (spec.layout ?? (lines.length ? 'flow' : 'grid')) === 'flow';
    const laid = useFlow ? flow(loose, lines, ids, spec.direction ?? 'down') : grid(loose, ids, 0, 0, perRowFor(loose.length)).boxes;
    const keys = keysBetween(null, null, laid.length);
    laid.forEach((b, i) => {
      const box = { ...b, x: b.x + cursorX };
      boxes.push(box);
      elements.push(itemElement(box.item, box.id, box.x, box.y, keys[i]!));
    });
  }

  // Lines between items, bound to both ends, above the items they join.
  const byKey = new Map(boxes.flatMap((b) => (b.item.key ? [[b.item.key, b] as const] : [])));
  const lineKeys = keysBetween(null, null, lines.length || 1);
  lines.forEach((l, i) => {
    const a = byKey.get(l.from);
    const b = byKey.get(l.to);
    if (!a || !b) return;
    const s = center(a);
    const e = center(b);
    elements.push({
      id: makeId(),
      type: 'connector',
      order: lineKeys[i]!,
      x: Math.min(s.x, e.x),
      y: Math.min(s.y, e.y),
      w: Math.abs(e.x - s.x),
      h: Math.abs(e.y - s.y),
      start: { ...s, el: a.id, side: 'auto' },
      end: { ...e, el: b.id, side: 'auto' },
      route: spec.layout === 'grid' ? 'straight' : 'elbow',
      startCap: 'none',
      endCap: 'arrow',
      stroke: '#1f2937',
      strokeWidth: 2,
      ...(l.label ? { text: plain(l.label), labelAt: 0.5 } : {}),
    });
  });

  const keys: Record<string, string> = {};
  for (const [item, id] of ids) if (item.key) keys[item.key] = id;
  return { fragment: toFragment(elements), keys };
}

export interface PlaceSpecOptions {
  /** Where the middle of the new content goes; default to the right of what is on the board. */
  at?: { x: number; y: number };
  /** Where its top-left corner goes instead (`at` wins when both are given). */
  topLeft?: { x: number; y: number };
  createdBy?: string;
  now?: number;
  makeId?: () => string;
}

/** Where new content goes when no point is given: right of everything on the board, top-aligned. */
export function freeSpot(board: Board): { x: number; y: number } {
  const bounds = selectionBounds(board, board.childIds(null));
  return bounds ? { x: bounds.x + bounds.w + 200, y: bounds.y } : { x: 0, y: 0 };
}

/**
 * A `create` op putting the spec on the board, the ids of the new top-level
 * elements, every new id, and the id each keyed item got.
 */
export function placeSpec(board: Board, spec: BoardSpec, options: PlaceSpecOptions = {}): { op: Op; ids: string[]; all: string[]; keys: Record<string, string> } {
  const makeId = options.makeId ?? (() => newId());
  const { fragment, keys } = fragmentFromSpec(spec, makeId);
  if (!fragment.elements.length) return { op: NOOP, ids: [], all: [], keys: {} };
  const spot = options.at ? { x: options.at.x - fragment.width / 2, y: options.at.y - fragment.height / 2 } : (options.topLeft ?? freeSpot(board));
  // placeFragment gives new ids again; map the spec's keys through it.
  const order = fragment.elements.map((e) => e.id);
  let n = 0;
  const fresh: string[] = [];
  const placed = placeFragment(board, fragment, {
    x: Math.round(spot.x),
    y: Math.round(spot.y),
    makeId: () => {
      const id = makeId();
      fresh[n++] = id;
      return id;
    },
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const remap = new Map(order.map((id, i) => [id, fresh[i]!]));
  const placedKeys = Object.fromEntries(Object.entries(keys).map(([k, id]) => [k, remap.get(id) ?? id]));
  return { ...placed, keys: placedKeys };
}

export interface Cluster {
  title: string;
  ids: string[];
}

/**
 * Groups elements by theme: one frame per cluster, side by side at `at` (or
 * in free space), each holding its elements in a grid. Elements are moved,
 * not copied; ids that are gone, or that sit in more than one cluster after
 * the first, are skipped.
 */
export function clusterOps(board: Board, clusters: Cluster[], options: PlaceSpecOptions = {}): { op: Op; frames: string[] } {
  const makeId = options.makeId ?? (() => newId());
  const seen = new Set<string>();
  const groups = clusters.slice(0, SPEC_LIMITS.frames).map((c) => ({
    title: clip(c.title, 200) || 'Theme',
    els: c.ids.flatMap((id) => {
      const el = board.get(id);
      if (!el || seen.has(id) || el.type === 'connector' || el.type === 'frame' || el.type === 'comment' || el.locked) return [];
      seen.add(id);
      return [el];
    }),
  })).filter((g) => g.els.length);
  if (!groups.length) return { op: NOOP, frames: [] };
  const start = options.at ?? freeSpot(board);
  const frameKeys = keysBetween(board.topOrder(null), null, groups.length);
  const ops: Op[] = [];
  const frames: string[] = [];
  let x = Math.round(start.x);
  groups.forEach((g, gi) => {
    const perRow = g.els.length > 4 ? 2 : 1;
    const frameId = makeId();
    frames.push(frameId);
    const placed: { el: BoardElement; x: number; y: number }[] = [];
    let rowY = FRAME_PAD + FRAME_TITLE;
    let width = 0;
    for (let i = 0; i < g.els.length; i += perRow) {
      const row = g.els.slice(i, i + perRow);
      let cx = FRAME_PAD;
      let rowH = 0;
      for (const el of row) {
        placed.push({ el, x: cx, y: rowY });
        cx += el.w + GAP;
        rowH = Math.max(rowH, el.h);
      }
      width = Math.max(width, cx - GAP);
      rowY += rowH + GAP;
    }
    const w = Math.max(320, width + FRAME_PAD);
    const h = Math.max(240, rowY - GAP + FRAME_PAD);
    const y = Math.round(start.y);
    ops.push({ type: 'create', elements: [{ id: frameId, type: 'frame', order: frameKeys[gi]!, x, y, w, h, name: g.title, fill: '#ffffff' }] });
    const childKeys = keysBetween(null, null, placed.length);
    placed.forEach((p, i) => ops.push({ type: 'set', id: p.el.id, patch: { parent: frameId, order: childKeys[i]!, x: x + p.x, y: y + p.y } }));
    x += w + GAP * 2;
  });
  return { op: batch(ops), frames };
}

/** The fill a spec colour gives an element of this type (a sticky shade, or a light fill). */
export function fillFor(type: BoardElement['type'], color: SpecColor): string {
  return type === 'sticky' ? STICKY_SHADE[color] : LIGHT_FILL[color];
}

export interface ElementChange {
  id: string;
  /** New text, replacing the old (a frame's title). */
  text?: string;
  color?: SpecColor;
  x?: number;
  y?: number;
  delete?: boolean;
}

const TEXT_TYPES = new Set<BoardElement['type']>(['sticky', 'shape', 'text', 'card', 'connector']);
const FILL_TYPES = new Set<BoardElement['type']>(['sticky', 'shape', 'card', 'frame']);

/**
 * Changes to elements already on a board, by id, as one op: text, colour,
 * position (a frame or group moves with its contents) or removal (with what is
 * inside). Missing, locked and comment elements are skipped, and so is a
 * change the element cannot take (a colour on a line).
 */
export function editOps(board: Board, changes: readonly ElementChange[]): { op: Op; changed: string[]; skipped: string[] } {
  const ops: Op[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const change of changes) {
    const el = board.get(change.id);
    if (!el || el.locked || el.type === 'comment') {
      skipped.push(change.id);
      continue;
    }
    if (change.delete) {
      removed.push(el.id);
      changed.push(el.id);
      continue;
    }
    let did = false;
    if (typeof change.text === 'string') {
      const text = clip(change.text);
      if (el.type === 'frame') {
        ops.push({ type: 'set', id: el.id, patch: { name: text.slice(0, 200) } });
        did = true;
      } else if (TEXT_TYPES.has(el.type)) {
        const length = el.text?.text.length ?? 0;
        if (!el.text) ops.push({ type: 'set', id: el.id, patch: { text: plain(text) } });
        else {
          if (length) ops.push({ type: 'deleteText', id: el.id, from: 0, to: length });
          if (text) ops.push({ type: 'insertText', id: el.id, at: 0, text: plain(text) });
        }
        did = true;
      }
    }
    const color = colorOf(change.color);
    if (color && FILL_TYPES.has(el.type)) {
      ops.push({ type: 'set', id: el.id, patch: { fill: fillFor(el.type, color) } });
      did = true;
    }
    const moves = (Number.isFinite(change.x) || Number.isFinite(change.y)) && el.type !== 'connector';
    if (moves) {
      const dx = Number.isFinite(change.x) ? change.x! - el.x : 0;
      const dy = Number.isFinite(change.y) ? change.y! - el.y : 0;
      if (dx || dy) ops.push(moveOps(board, [el.id], dx, dy));
      did = true;
    }
    (did ? changed : skipped).push(el.id);
  }
  if (removed.length) ops.push(deleteOps(board, removed));
  return { op: batch(ops), changed, skipped };
}
