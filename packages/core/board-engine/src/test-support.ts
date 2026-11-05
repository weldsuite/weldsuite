/**
 * Test helpers: a seeded random source and a random-op generator that only
 * makes ops `validateOp` accepts on the board it is given.
 */

import type { Board } from './model/board';
import { STICKY_COLORS } from './model/defaults';
import { keyBetween } from './model/order';
import { keyAllowed } from './model/schema';
import type { BoardElement } from './model/types';
import type { Op } from './ops/types';

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

export function counterIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(++n).toString(36)}`;
}

function pick<T>(random: () => number, list: readonly T[]): T | undefined {
  return list.length ? list[Math.floor(random() * list.length)] : undefined;
}

const WORDS = ['plan', 'idea', 'goal', 'risk', 'note', ' ', '\n', 'é', '😀'];

function newElement(board: Board, random: () => number, makeId: () => string): BoardElement {
  const id = makeId();
  const frames = [...board.elements.values()].filter((e) => e.type === 'frame');
  const parent = random() < 0.3 ? pick(random, frames)?.id : undefined;
  const order = keyBetween(board.topOrder(parent ?? null), null);
  const x = Math.round(random() * 2000);
  const y = Math.round(random() * 2000);
  const r = random();
  if (r < 0.35) return { id, type: 'sticky', order, x, y, w: 200, h: 200, fill: pick(random, STICKY_COLORS)!, text: { text: 'hi', marks: [] }, ...(parent ? { parent } : {}) };
  if (r < 0.6) return { id, type: 'shape', shape: 'rectangle', order, x, y, w: 120, h: 80, ...(parent ? { parent } : {}) };
  if (r < 0.7) return { id, type: 'frame', name: 'F', order, x, y, w: 800, h: 600 };
  const targets = [...board.elements.values()].filter((e) => e.type !== 'connector');
  const a = pick(random, targets);
  const b = pick(random, targets);
  return {
    id,
    type: 'connector',
    order,
    x,
    y,
    w: 0,
    h: 0,
    start: { x, y, ...(a ? { el: a.id, side: 'auto' as const } : {}) },
    end: { x: x + 100, y: y + 50, ...(b ? { el: b.id, side: 'right' as const } : {}) },
    route: pick(random, ['straight', 'elbow', 'curved'] as const)!,
  };
}

/** A random op that is valid on `board`, or null when it could not make one. */
export function randomOp(board: Board, random: () => number, makeId: () => string): Op | null {
  const all = [...board.elements.values()];
  const texty = all.filter((e) => keyAllowed(e.type, 'text'));
  const r = random();
  if (r < 0.2 || all.length < 3) return { type: 'create', elements: [newElement(board, random, makeId)] };
  if (r < 0.27) {
    const el = pick(random, all)!;
    return { type: 'delete', ids: [el.id, ...(random() < 0.5 ? board.descendants(el.id) : [])] };
  }
  if (r < 0.5) {
    const el = pick(random, all)!;
    const patch: Record<string, unknown> = {};
    const k = random();
    if (k < 0.3) patch.x = Math.round(random() * 2000);
    else if (k < 0.45) patch.y = Math.round(random() * 2000);
    else if (k < 0.55 && keyAllowed(el.type, 'fill')) patch.fill = pick(random, STICKY_COLORS)!;
    else if (k < 0.65) patch.order = keyBetween(board.topOrder(board.effectiveParent(el)), null);
    else if (k < 0.75 && el.type !== 'frame') {
      const frames = all.filter((e) => e.type === 'frame' && e.id !== el.id);
      const f = pick(random, frames);
      patch.parent = f && random() < 0.6 ? f.id : null;
    } else if (k < 0.85 && keyAllowed(el.type, 'locked')) patch.locked = random() < 0.5;
    else patch.w = Math.round(50 + random() * 300);
    return { type: 'set', id: el.id, patch };
  }
  if (r < 0.85 && texty.length) {
    const el = pick(random, texty)!;
    const text = el.text?.text ?? '';
    const k = random();
    // Positions never split a surrogate pair.
    const positions: number[] = [];
    for (let i = 0; i <= text.length; i++) {
      const c = text.charCodeAt(i);
      if (!(c >= 0xdc00 && c <= 0xdfff)) positions.push(i);
    }
    if (k < 0.55 || text.length === 0) {
      const at = pick(random, positions)!;
      const word = pick(random, WORDS)!;
      return { type: 'insertText', id: el.id, at, text: { text: word, marks: random() < 0.3 ? [[word.length, { b: true }]] : [] } };
    }
    const a = pick(random, positions)!;
    const b = pick(random, positions)!;
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    if (k < 0.8) return from < to ? { type: 'deleteText', id: el.id, from, to } : null;
    return from < to ? { type: 'formatText', id: el.id, at: from, runs: [[to - from, random() < 0.5 ? { i: true } : { c: '#ff0000', b: null }]] } : null;
  }
  if (r < 0.92) return { type: 'setBoard', patch: random() < 0.5 ? { background: pick(random, STICKY_COLORS)! } : { grid: random() < 0.5 ? 'dots' : 'none' } };
  const voteFor = all.filter((e) => e.type === 'sticky').slice(0, 3).map((e) => e.id);
  return { type: 'vote', user: `u${Math.floor(random() * 3)}`, elements: voteFor.length && random() < 0.8 ? voteFor : null };
}
