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
import { unbatch, type Op, type OpOf, type SimpleOp } from './types';

export function validateOp(board: Board, op: Op): string | null {
  // Ops in a batch apply in order, so later ones see what earlier ones created or removed.
  const check = new BatchCheck(board);
  for (const o of unbatch(op) as SimpleOp[]) {
    const error = check.next(o);
    if (error !== null) return error;
  }
  return null;
}

/** The board as the ops of a batch checked so far leave it. */
class BatchCheck {
  private readonly created = new Map<string, BoardElement>();
  private readonly deleted = new Set<string>();
  private readonly textLength = new Map<string, number>();
  private count: number;

  constructor(private readonly board: Board) {
    this.count = board.size;
  }

  private readonly lookup = (id: string): BoardElement | undefined =>
    this.deleted.has(id) ? undefined : (this.created.get(id) ?? this.board.get(id));

  private lengthOf(id: string): number {
    return this.textLength.get(id) ?? this.lookup(id)?.text?.text.length ?? 0;
  }

  /** Checks the next op of the batch and takes it into account; null when it may be applied. */
  next(o: SimpleOp): string | null {
    switch (o.type) {
      case 'create':
        return this.create(o);
      case 'delete':
        this.delete(o);
        return null;
      case 'set':
        return this.set(o);
      case 'insertText':
      case 'deleteText':
      case 'formatText':
        return this.textEdit(o);
      default:
        return null;
    }
  }

  private create(o: OpOf<'create'>): string | null {
    for (const el of o.elements) {
      if (this.lookup(el.id) || this.created.has(el.id)) return `element ${el.id} already exists`;
      if (el.parent === el.id) return 'an element cannot contain itself';
      this.created.set(el.id, el);
      this.deleted.delete(el.id);
      this.textLength.delete(el.id);
      this.count++;
    }
    return this.count > MAX_ELEMENTS ? 'the board is full' : null;
  }

  private delete(o: OpOf<'delete'>): void {
    for (const id of o.ids) {
      if (this.lookup(id)) this.count--;
      this.deleted.add(id);
      this.created.delete(id);
    }
  }

  private set(o: OpOf<'set'>): string | null {
    const el = this.lookup(o.id);
    if (!el) return null;
    for (const k of Object.keys(o.patch)) if (!keyAllowed(el.type, k)) return `${el.type} has no ${k}`;
    const parent = o.patch.parent;
    if (typeof parent === 'string') {
      if (parent === o.id) return 'an element cannot contain itself';
      if (isInside(parent, o.id, this.lookup)) return 'an element cannot move inside its own contents';
    }
    if ('text' in o.patch) this.textLength.set(o.id, (o.patch.text as { text: string } | null)?.text.length ?? 0);
    this.created.set(o.id, { ...el, ...(o.patch as Partial<BoardElement>) });
    return null;
  }

  private textEdit(o: OpOf<'insertText' | 'deleteText' | 'formatText'>): string | null {
    const el = this.lookup(o.id);
    if (!el) return null;
    if (!keyAllowed(el.type, 'text')) return `${el.type} has no text`;
    const len = this.lengthOf(o.id);
    const text = currentText(el);
    if (o.type === 'insertText') return this.insertText(o, el, len, text);
    if (o.type === 'deleteText') return this.deleteText(o, el, len, text);
    return o.at + runsLength(o.runs) > len ? 'format past the end of the text' : null;
  }

  private insertText(o: OpOf<'insertText'>, el: BoardElement, len: number, text: string | null): string | null {
    if (o.at > len) return 'text insert out of range';
    if (len + o.text.text.length > MAX_TEXT) return 'text too long';
    if (text !== null && splitsSurrogate(text, o.at)) return 'insert splits a character';
    this.textLength.set(o.id, len + o.text.text.length);
    // Later ops in the batch see the new length; the text itself is checked only for the first edit.
    this.created.set(o.id, { ...el, text: undefined });
    return null;
  }

  private deleteText(o: OpOf<'deleteText'>, el: BoardElement, len: number, text: string | null): string | null {
    if (o.from > o.to || o.to > len) return 'text delete out of range';
    if (text !== null && (splitsSurrogate(text, o.from) || splitsSurrogate(text, o.to))) return 'delete splits a character';
    this.textLength.set(o.id, len - (o.to - o.from));
    this.created.set(o.id, { ...el, text: undefined });
    return null;
  }
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
