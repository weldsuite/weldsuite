/**
 * Mind maps: nodes are stickies, shapes or text boxes carrying `mindmap`
 * ({ root, parent, side }); the root's `root` is its own id. Lines between
 * a node and its parent are ordinary curved connectors bound to their sides.
 *
 * Layout is a horizontal tree: each side of the root stacks its subtrees
 * vertically, centred on their parent. The layout is written to the board as
 * position ops, so every replica shows the same map.
 */

import type { Board } from '../model/board';
import { keyBetween } from '../model/order';
import { plain } from '../model/text';
import type { BoardElement } from '../model/types';
import { batch, NOOP, type Op } from '../ops/types';

const H_GAP = 80;
const V_GAP = 24;

export function isMindMapNode(el: BoardElement | undefined): boolean {
  return !!el?.mindmap;
}

/** Child nodes of a node, top to bottom. */
export function mindMapChildren(board: Board, id: string): BoardElement[] {
  const out: BoardElement[] = [];
  for (const el of board.elements.values()) if (el.mindmap?.parent === id && el.id !== id) out.push(el);
  return out.sort((a, b) => a.y - b.y || (a.order < b.order ? -1 : 1));
}

/** Whether a node is hidden because an ancestor is collapsed. */
export function isCollapsedAway(board: Board, el: BoardElement): boolean {
  let parentId = el.mindmap?.parent;
  for (let guard = 0; parentId && guard < 500; guard++) {
    const parent = board.get(parentId);
    if (!parent?.mindmap) return false;
    if (parent.mindmap.collapsed) return true;
    parentId = parent.mindmap.parent;
  }
  return false;
}

function sideOf(board: Board, el: BoardElement): 'left' | 'right' {
  let current: BoardElement | undefined = el;
  for (let guard = 0; current?.mindmap && guard < 500; guard++) {
    if (current.mindmap.side) return current.mindmap.side;
    current = current.mindmap.parent ? board.get(current.mindmap.parent) : undefined;
  }
  return 'right';
}

/** Positions for every node of a map, keyed by id. */
export function mindMapLayout(board: Board, rootId: string): Map<string, { x: number; y: number }> {
  const root = board.get(rootId);
  const out = new Map<string, { x: number; y: number }>();
  if (!root) return out;
  const heights = new Map<string, number>();
  const visiting = new Set<string>();
  const subtreeHeight = (el: BoardElement): number => {
    if (visiting.has(el.id)) return el.h;
    visiting.add(el.id);
    const kids = el.mindmap?.collapsed ? [] : mindMapChildren(board, el.id);
    const kidsH = kids.reduce((n, k) => n + subtreeHeight(k), 0) + Math.max(0, kids.length - 1) * V_GAP;
    const h = Math.max(el.h, kidsH);
    heights.set(el.id, h);
    return h;
  };
  const place = (el: BoardElement, side: 'left' | 'right') => {
    if (el.mindmap?.collapsed) return;
    const kids = mindMapChildren(board, el.id).filter((k) => el.id !== rootId || sideOf(board, k) === side);
    const total = kids.reduce((n, k) => n + subtreeHeight(k), 0) + Math.max(0, kids.length - 1) * V_GAP;
    const pos = out.get(el.id) ?? { x: el.x, y: el.y };
    let y = pos.y + el.h / 2 - total / 2;
    for (const k of kids) {
      const h = heights.get(k.id) ?? k.h;
      const x = side === 'right' ? pos.x + el.w + H_GAP : pos.x - H_GAP - k.w;
      out.set(k.id, { x, y: y + h / 2 - k.h / 2 });
      place(k, side);
      y += h + V_GAP;
    }
  };
  out.set(root.id, { x: root.x, y: root.y });
  for (const k of mindMapChildren(board, rootId)) subtreeHeight(k);
  place(root, 'right');
  place(root, 'left');
  return out;
}

/** Moves every node of the map to its laid-out place. */
export function mindMapLayoutOps(board: Board, rootId: string): Op {
  const ops: Op[] = [];
  for (const [id, pos] of mindMapLayout(board, rootId)) {
    const el = board.get(id);
    if (!el || (Math.abs(el.x - pos.x) < 0.01 && Math.abs(el.y - pos.y) < 0.01)) continue;
    ops.push({ type: 'set', id, patch: { x: pos.x, y: pos.y } });
  }
  return batch(ops);
}

/**
 * Adds a child to a node, with its connector: the op, plus the new node's
 * id. Lay the map out afterwards (`mindMapLayoutOps`).
 */
export function addMindMapChild(
  board: Board,
  parentId: string,
  ids: { node: string; line: string },
  options: { side?: 'left' | 'right'; text?: string; createdBy?: string } = {},
): Op {
  const parent = board.get(parentId);
  if (!parent?.mindmap) return NOOP;
  const rootId = parent.mindmap.root;
  const side = parentId === rootId ? (options.side ?? 'right') : sideOf(board, parent);
  const x = side === 'right' ? parent.x + parent.w + H_GAP : parent.x - H_GAP - 180;
  const y = parent.y + parent.h + V_GAP;
  const top = board.topOrder(board.effectiveParent(parent));
  const lineOrder = keyBetween(top, null);
  const nodeOrder = keyBetween(lineOrder, null);
  const node: BoardElement = {
    id: ids.node,
    type: 'shape',
    shape: 'rounded',
    order: nodeOrder,
    x,
    y,
    w: 180,
    h: 56,
    fill: parent.fill ?? '#ffffff',
    stroke: parent.stroke ?? '#1f2937',
    strokeWidth: 2,
    text: plain(options.text ?? ''),
    fontSize: 16,
    textAlign: 'center',
    vAlign: 'middle',
    mindmap: { root: rootId, parent: parentId, ...(parentId === rootId ? { side } : {}) },
    ...(parent.parent ? { parent: parent.parent } : {}),
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
  };
  const line: BoardElement = {
    id: ids.line,
    type: 'connector',
    order: lineOrder,
    x: parent.x,
    y: parent.y,
    w: 0,
    h: 0,
    start: { x: parent.x + parent.w, y: parent.y + parent.h / 2, el: parentId, side: side === 'right' ? 'right' : 'left' },
    end: { x, y: y + 28, el: ids.node, side: side === 'right' ? 'left' : 'right' },
    route: 'curved',
    startCap: 'none',
    endCap: 'none',
    stroke: '#94a3b8',
    strokeWidth: 2,
    ...(parent.parent ? { parent: parent.parent } : {}),
  };
  return { type: 'create', elements: [line, node] };
}
