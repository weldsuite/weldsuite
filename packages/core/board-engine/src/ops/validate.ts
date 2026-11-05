/**
 * Checks a well-formed op against the board it would apply to: ids that
 * must be new are new, text positions are in range, a frame is not put
 * inside itself. Null when the op may be applied, else why not.
 *
 * Edits of elements that no longer exist pass: they apply as no-ops.
 */

import type { Board } from '../model/board';
import { keyAllowed, MAX_ELEMENTS } from '../model/schema';
import { MAX_TEXT, splitsSurrogate } from '../model/text';
import type { BoardElement } from '../model/types';
import { runsLength } from './transform';
import { unbatch, type Op, type SimpleOp } from './types';

export function validateOp(board: Board, op: Op): string | null {
  // Ops in a batch apply in order, so later ones see what earlier ones created or removed.
  const created = new Map<string, BoardElement>();
  const deleted = new Set<string>();
  const textLength = new Map<string, number>();
  let count = board.size;

  const lookup = (id: string): BoardElement | undefined => (deleted.has(id) ? undefined : (created.get(id) ?? board.get(id)));
  const lengthOf = (id: string): number => textLength.get(id) ?? lookup(id)?.text?.text.length ?? 0;

  for (const o of unbatch(op) as SimpleOp[]) {
    switch (o.type) {
      case 'create': {
        for (const el of o.elements) {
          if (lookup(el.id) || created.has(el.id)) return `element ${el.id} already exists`;
          if (el.parent === el.id) return 'an element cannot contain itself';
          created.set(el.id, el);
          deleted.delete(el.id);
          textLength.delete(el.id);
          count++;
        }
        if (count > MAX_ELEMENTS) return 'the board is full';
        break;
      }
      case 'delete':
        for (const id of o.ids) {
          if (lookup(id)) count--;
          deleted.add(id);
          created.delete(id);
        }
        break;
      case 'set': {
        const el = lookup(o.id);
        if (!el) break;
        for (const k of Object.keys(o.patch)) if (!keyAllowed(el.type, k)) return `${el.type} has no ${k}`;
        const parent = o.patch.parent;
        if (typeof parent === 'string') {
          if (parent === o.id) return 'an element cannot contain itself';
          if (isInside(parent, o.id, lookup)) return 'an element cannot move inside its own contents';
        }
        if ('text' in o.patch) textLength.set(o.id, (o.patch.text as { text: string } | null)?.text.length ?? 0);
        created.set(o.id, { ...el, ...(o.patch as Partial<BoardElement>) });
        break;
      }
      case 'insertText':
      case 'deleteText':
      case 'formatText': {
        const el = lookup(o.id);
        if (!el) break;
        if (!keyAllowed(el.type, 'text')) return `${el.type} has no text`;
        const len = lengthOf(o.id);
        const text = currentText(el);
        if (o.type === 'insertText') {
          if (o.at > len) return 'text insert out of range';
          if (len + o.text.text.length > MAX_TEXT) return 'text too long';
          if (text !== null && splitsSurrogate(text, o.at)) return 'insert splits a character';
          textLength.set(o.id, len + o.text.text.length);
          // Later ops in the batch see the new length; the text itself is checked only for the first edit.
          created.set(o.id, { ...el, text: undefined });
        } else if (o.type === 'deleteText') {
          if (o.from > o.to || o.to > len) return 'text delete out of range';
          if (text !== null && (splitsSurrogate(text, o.from) || splitsSurrogate(text, o.to))) return 'delete splits a character';
          textLength.set(o.id, len - (o.to - o.from));
          created.set(o.id, { ...el, text: undefined });
        } else if (o.at + runsLength(o.runs) > len) return 'format past the end of the text';
        break;
      }
      default:
        break;
    }
  }
  return null;
}

/** The element's text as stored, or null when an earlier op in the batch changed it. */
function currentText(el: BoardElement): string | null {
  if (!('text' in el)) return '';
  return el.text ? el.text.text : null;
}

/** Whether `id` sits inside `ancestor`. */
function isInside(id: string, ancestor: string, lookup: (id: string) => BoardElement | undefined): boolean {
  let current = lookup(id);
  for (let guard = 0; current && guard < 1000; guard++) {
    const p = current.parent ?? null;
    if (p === null) return false;
    if (p === ancestor) return true;
    current = lookup(p);
  }
  return false;
}
