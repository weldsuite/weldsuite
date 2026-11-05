/**
 * Applies an op to a board in place and returns its exact inverse (what
 * undo replays). An op on an element that is gone does nothing and returns
 * a no-op inverse.
 */

import type { Board } from '../model/board';
import { deleteRich, formatRich, insertRich, plain, sliceRich } from '../model/text';
import type { BoardElement, BoardProps } from '../model/types';
import { NOOP, batch, type Op, type OpOf } from './types';

const STRUCTURAL_KEYS = ['parent', 'order'];

/** Empty text is stored as no text, so an insert and its undo leave the element exactly as it was. */
function tidy(el: BoardElement): BoardElement {
  if (el.text && el.text.text.length === 0) {
    const copy = { ...el };
    delete copy.text;
    return copy;
  }
  return el;
}

export function applyOp(board: Board, op: Op): Op {
  const inverse = applySimple(board, op);
  board.version++;
  return inverse;
}

function applySimple(board: Board, op: Op): Op {
  switch (op.type) {
    case 'batch': {
      const inverses: Op[] = [];
      for (const o of op.ops) inverses.push(applySimple(board, o));
      return batch(inverses.reverse());
    }
    case 'create':
      return applyCreate(board, op);
    case 'delete':
      return applyDelete(board, op);
    case 'set':
      return applySet(board, op);
    case 'insertText':
      return applyInsertText(board, op);
    case 'deleteText':
      return applyDeleteText(board, op);
    case 'formatText':
      return applyFormatText(board, op);
    case 'setBoard':
      return applySetBoard(board, op);
    case 'vote':
      return applyVote(board, op);
  }
}

function applyCreate(board: Board, op: OpOf<'create'>): Op {
  for (const el of op.elements) {
    if (board.elements.has(el.id)) throw new Error(`element ${el.id} already exists`);
    board.elements.set(el.id, tidy(structuredClone(el)));
    board.touch(el.id, true);
  }
  return { type: 'delete', ids: op.elements.map((e) => e.id) };
}

function applyDelete(board: Board, op: OpOf<'delete'>): Op {
  const removed: BoardElement[] = [];
  for (const id of op.ids) {
    const el = board.elements.get(id);
    if (!el) continue;
    removed.push(el);
    board.elements.delete(id);
    board.touch(id, true);
  }
  return removed.length ? { type: 'create', elements: removed } : NOOP;
}

function patched<T extends object>(target: T, patch: Record<string, unknown>): { next: T; revert: Record<string, unknown> } {
  const next = { ...target } as Record<string, unknown>;
  const revert: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    revert[k] = k in next ? structuredClone(next[k]) : null;
    if (v === null) delete next[k];
    else next[k] = structuredClone(v);
  }
  return { next: next as T, revert };
}

function applySet(board: Board, op: OpOf<'set'>): Op {
  const el = board.elements.get(op.id);
  if (!el) return NOOP;
  const { next, revert } = patched(el, op.patch);
  // `parent: null` means the top level: store it as an absent key.
  if ((next as BoardElement).parent === undefined) delete (next as BoardElement).parent;
  board.elements.set(op.id, tidy(next));
  board.touch(op.id, STRUCTURAL_KEYS.some((k) => k in op.patch));
  return { type: 'set', id: op.id, patch: revert };
}

function applyInsertText(board: Board, op: OpOf<'insertText'>): Op {
  const el = board.elements.get(op.id);
  if (!el) return NOOP;
  const text = el.text ?? plain();
  if (op.at < 0 || op.at > text.text.length) throw new Error('text insert out of range');
  board.elements.set(op.id, tidy({ ...el, text: insertRich(text, op.at, op.text) }));
  board.touch(op.id, false);
  return { type: 'deleteText', id: op.id, from: op.at, to: op.at + op.text.text.length };
}

function applyDeleteText(board: Board, op: OpOf<'deleteText'>): Op {
  const el = board.elements.get(op.id);
  if (!el) return NOOP;
  const text = el.text ?? plain();
  if (op.from < 0 || op.to > text.text.length || op.from > op.to) throw new Error('text delete out of range');
  const removed = sliceRich(text, op.from, op.to);
  board.elements.set(op.id, tidy({ ...el, text: deleteRich(text, op.from, op.to) }));
  board.touch(op.id, false);
  return { type: 'insertText', id: op.id, at: op.from, text: removed };
}

function applyFormatText(board: Board, op: OpOf<'formatText'>): Op {
  const el = board.elements.get(op.id);
  if (!el) return NOOP;
  const text = el.text ?? plain();
  const { text: next, inverse } = formatRich(text, op.at, op.runs);
  board.elements.set(op.id, tidy({ ...el, text: next }));
  board.touch(op.id, false);
  return { type: 'formatText', id: op.id, at: op.at, runs: inverse };
}

function applySetBoard(board: Board, op: OpOf<'setBoard'>): Op {
  const { next, revert } = patched<BoardProps>(board.props, op.patch);
  board.props = next;
  return { type: 'setBoard', patch: revert };
}

function applyVote(board: Board, op: OpOf<'vote'>): Op {
  const before = board.votes.get(op.user) ?? null;
  if (op.elements === null || op.elements.length === 0) board.votes.delete(op.user);
  else board.votes.set(op.user, [...op.elements]);
  return { type: 'vote', user: op.user, elements: before ? [...before] : null };
}
