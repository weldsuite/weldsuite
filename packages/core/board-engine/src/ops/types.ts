/**
 * Operations: every change to a board is one of these. Plain JSON, so they
 * travel over the collaboration socket, sit in the op log and replay.
 *
 * Ops address elements by id. An op on an element that no longer exists
 * does nothing (someone deleted it meanwhile); the room never has to refuse
 * an edit because of that race.
 */

import type { MarksPatch } from '../model/text';
import type { BoardElement, RichText } from '../model/types';

/** `[length, patch]`; a null patch leaves that stretch alone. */
export type MarksRun = [number, MarksPatch | null];

export type Op =
  /** Adds elements (in this order: parents before their children). */
  | { type: 'create'; elements: BoardElement[] }
  /** Removes elements. List every id to remove: children are not removed with their frame. */
  | { type: 'delete'; ids: string[] }
  /** Sets properties of one element; a null value removes that property. */
  | { type: 'set'; id: string; patch: Record<string, unknown> }
  /** Inserts text into an element's text at `at`. */
  | { type: 'insertText'; id: string; at: number; text: RichText }
  /** Deletes [from, to) of an element's text. */
  | { type: 'deleteText'; id: string; from: number; to: number }
  /** Patches the marks of the runs from `at` on. */
  | { type: 'formatText'; id: string; at: number; runs: MarksRun[] }
  /** Sets board properties; a null value removes that property. */
  | { type: 'setBoard'; patch: Record<string, unknown> }
  /** Sets one person's votes in the open session (null: withdraws them all). */
  | { type: 'vote'; user: string; elements: string[] | null }
  /** Applied in order, atomically. */
  | { type: 'batch'; ops: Op[] };

export type OpType = Op['type'];
export type SimpleOp = Exclude<Op, { type: 'batch' }>;
export type OpOf<T extends OpType> = Extract<Op, { type: T }>;

export const NOOP: Op = { type: 'batch', ops: [] };

export function isNoop(op: Op): boolean {
  return op.type === 'batch' && op.ops.length === 0;
}

function isEmptySimple(op: SimpleOp): boolean {
  switch (op.type) {
    case 'create':
      return op.elements.length === 0;
    case 'delete':
      return op.ids.length === 0;
    case 'set':
    case 'setBoard':
      return Object.keys(op.patch).length === 0;
    case 'insertText':
      return op.text.text.length === 0;
    case 'deleteText':
      return op.from >= op.to;
    case 'formatText':
      return op.runs.every(([len, patch]) => len === 0 || patch === null || Object.keys(patch).length === 0);
    case 'vote':
      return false;
  }
}

/** Flattens nested batches, drops no-ops, and unwraps a batch of one. */
export function normalize(op: Op): Op {
  if (op.type !== 'batch') return isEmptySimple(op) ? NOOP : op;
  const flat: SimpleOp[] = [];
  const add = (o: Op) => {
    if (o.type === 'batch') o.ops.forEach(add);
    else if (!isEmptySimple(o)) flat.push(o);
  };
  add(op);
  return flat.length === 1 ? flat[0]! : { type: 'batch', ops: flat };
}

export function batch(ops: Op[]): Op {
  return normalize({ type: 'batch', ops });
}

export function unbatch(op: Op): Op[] {
  const n = normalize(op);
  return n.type === 'batch' ? n.ops : [n];
}

/** Ids of the elements an op touches. */
export function touchedIds(op: Op): string[] {
  switch (op.type) {
    case 'create':
      return op.elements.map((e) => e.id);
    case 'delete':
      return op.ids;
    case 'set':
    case 'insertText':
    case 'deleteText':
    case 'formatText':
      return [op.id];
    case 'batch':
      return op.ops.flatMap(touchedIds);
    default:
      return [];
  }
}
