/**
 * Shape checks of untrusted JSON: an op from a browser is well-formed when
 * every field that normalize, transform and apply read has the type they
 * expect, all the way down. Checked before anything else touches it.
 */

import { isBoardPatch, isElement, isElementPatch, isId } from '../model/schema';
import { isMarksPatch, isRichText, MAX_TEXT } from '../model/text';
import type { Op } from './types';

const MAX_BATCH_DEPTH = 6;
const MAX_OPS = 20_000;
const MAX_CREATE = 10_000;

function isPos(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TEXT;
}

export function isWellFormedOp(v: unknown): v is Op {
  const counter = { ops: 0 };
  return check(v, 0, counter);
}

function check(v: unknown, depth: number, counter: { ops: number }): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  if (++counter.ops > MAX_OPS) return false;
  const op = v as Record<string, unknown>;
  const keys = Object.keys(op);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (op.type) {
    case 'batch':
      return only('type', 'ops') && depth < MAX_BATCH_DEPTH && Array.isArray(op.ops) && op.ops.every((o) => check(o, depth + 1, counter));
    case 'create':
      return (
        only('type', 'elements') &&
        Array.isArray(op.elements) &&
        op.elements.length <= MAX_CREATE &&
        op.elements.every(isElement)
      );
    case 'delete':
      return only('type', 'ids') && Array.isArray(op.ids) && op.ids.length <= MAX_CREATE && op.ids.every(isId);
    case 'set':
      return only('type', 'id', 'patch') && isId(op.id) && isElementPatch(op.patch);
    case 'insertText':
      return only('type', 'id', 'at', 'text') && isId(op.id) && isPos(op.at) && isRichText(op.text);
    case 'deleteText':
      return only('type', 'id', 'from', 'to') && isId(op.id) && isPos(op.from) && isPos(op.to);
    case 'formatText':
      return (
        only('type', 'id', 'at', 'runs') &&
        isId(op.id) &&
        isPos(op.at) &&
        Array.isArray(op.runs) &&
        op.runs.length <= MAX_TEXT &&
        op.runs.every(
          (r) => Array.isArray(r) && r.length === 2 && isPos(r[0]) && (r[1] === null || isMarksPatch(r[1])),
        )
      );
    case 'setBoard':
      return only('type', 'patch') && isBoardPatch(op.patch);
    case 'vote':
      return (
        only('type', 'user', 'elements') &&
        typeof op.user === 'string' &&
        op.user.length > 0 &&
        op.user.length <= 128 &&
        (op.elements === null || (Array.isArray(op.elements) && op.elements.length <= 100 && op.elements.every(isId)))
      );
    default:
      return false;
  }
}
