/**
 * A toy document for the protocol tests: a list of strings, edited by
 * inserting and deleting items. Small enough to transform by hand, rich
 * enough to conflict.
 */

import type { OtAdapter } from '../adapter';

export type Step = { type: 'ins'; at: number; item: string } | { type: 'del'; at: number };
export type ListOp = Step | { type: 'batch'; ops: ListOp[] };
export type Cursor = { index: number };
export type ListState = { items: string[] };

export const NOOP: ListOp = { type: 'batch', ops: [] };

export function flatten(op: ListOp): Step[] {
  return op.type === 'batch' ? op.ops.flatMap(flatten) : [op];
}

function applyList(state: ListState, op: ListOp): ListOp {
  switch (op.type) {
    case 'ins':
      if (op.at < 0 || op.at > state.items.length) throw new Error('insert out of range');
      state.items.splice(op.at, 0, op.item);
      return { type: 'del', at: op.at };
    case 'del': {
      if (op.at < 0 || op.at >= state.items.length) throw new Error('delete out of range');
      const [item] = state.items.splice(op.at, 1);
      return { type: 'ins', at: op.at, item: item! };
    }
    case 'batch':
      return { type: 'batch', ops: op.ops.map((o) => applyList(state, o)).reverse() };
  }
}

function transformList(a: ListOp, b: ListOp, aWins: boolean): ListOp {
  if (b.type === 'batch') return b.ops.reduce((acc, bi) => transformList(acc, bi, aWins), a);
  if (a.type === 'batch') {
    let against: ListOp = b;
    const ops = a.ops.map((ai) => {
      const t = transformList(ai, against, aWins);
      against = transformList(against, ai, !aWins);
      return t;
    });
    return { type: 'batch', ops };
  }
  if (a.type === 'ins') {
    if (b.type === 'ins') return a.at > b.at || (a.at === b.at && aWins) ? { ...a, at: a.at + 1 } : a;
    return a.at > b.at ? { ...a, at: a.at - 1 } : a;
  }
  if (b.type === 'ins') return a.at >= b.at ? { ...a, at: a.at + 1 } : a;
  if (a.at === b.at) return NOOP;
  return a.at > b.at ? { ...a, at: a.at - 1 } : a;
}

function isListOp(v: unknown, depth = 0): v is ListOp {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.type === 'batch') return depth < 3 && Array.isArray(o.ops) && o.ops.every((x) => isListOp(x, depth + 1));
  if (o.type === 'del') return Number.isInteger(o.at);
  return o.type === 'ins' && Number.isInteger(o.at) && typeof o.item === 'string';
}

export const listAdapter: OtAdapter<ListState, ListOp, string[], Cursor> = {
  load: (snapshot) => ({ items: [...snapshot] }),
  snapshot: (state) => [...state.items],
  apply: applyList,
  transform: transformList,
  normalize: (op) => {
    const ops = flatten(op);
    return ops.length === 1 ? ops[0]! : { type: 'batch', ops };
  },
  batch: (ops) => ({ type: 'batch', ops }),
  unbatch: (op) => (op.type === 'batch' ? op.ops : [op]),
  isWellFormedOp: (v): v is ListOp => isListOp(v),
  validate: (state, op) => {
    let length = state.items.length;
    for (const o of flatten(op)) {
      if (o.type === 'ins' ? o.at < 0 || o.at > length : o.at < 0 || o.at >= length) return 'out of range';
      length += o.type === 'ins' ? 1 : -1;
    }
    return null;
  },
  isPresence: (v): v is Cursor => typeof v === 'object' && v !== null && Number.isInteger((v as Cursor).index),
};
