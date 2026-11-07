/**
 * Undo history for one person on a shared board. Each entry keeps the op
 * that steps back (`inverse`); when someone else's op arrives, entries move
 * past it newest first, so undo never takes back a collaborator's work.
 *
 * Ops of one gesture (a drag, a resize, a run of typing) merge into one
 * entry, and repeated `set`s of the same property in it are compacted, so a
 * long drag stays one small step.
 */

import { batch, isNoop, normalize, transform, unbatch, type Op } from '@weldsuite/board-engine';

export interface HistoryEntry {
  op: Op;
  inverse: Op;
  /** Ops with the same gesture key, made one after the other, are one step. */
  gesture?: string;
  at: number;
  before: string[];
  after: string[];
}

const LIMIT = 200;
const TYPING_MS = 1200;

/**
 * Keeps, per element and key, only one `set`: the last one applied (for an
 * op going forward) or, for an inverse, also the last one (inverses are
 * stored newest-first, so the last applied is the oldest value).
 */
export function compactSets(op: Op): Op {
  const ops = unbatch(op);
  if (!ops.every((o) => o.type === 'set')) return op;
  const order: string[] = [];
  const merged = new Map<string, Record<string, unknown>>();
  for (const o of ops) {
    if (o.type !== 'set') continue;
    let patch = merged.get(o.id);
    if (!patch) {
      patch = {};
      merged.set(o.id, patch);
      order.push(o.id);
    }
    Object.assign(patch, o.patch);
  }
  return batch(order.map((id) => ({ type: 'set' as const, id, patch: merged.get(id)! })));
}

export class History {
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  record(op: Op, inverse: Op, options: { gesture?: string; before: string[]; after: string[] }): void {
    if (isNoop(op)) return;
    const now = Date.now();
    const last = this.undoStack[this.undoStack.length - 1];
    const sameGesture =
      options.gesture !== undefined &&
      last?.gesture === options.gesture &&
      (!options.gesture.startsWith('type:') || now - last.at < TYPING_MS);
    if (last && sameGesture) {
      last.op = compactSets(normalize(batch([last.op, op])));
      last.inverse = compactSets(normalize(batch([inverse, last.inverse])));
      last.after = options.after;
      last.at = now;
    } else {
      this.undoStack.push({ op, inverse, gesture: options.gesture, at: now, before: options.before, after: options.after });
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /** Ends the current gesture: the next op starts a new step even with the same key. */
  seal(): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last) last.gesture = undefined;
  }

  /** Someone else's op, as it applies to the local state now. */
  remote(op: Op): void {
    for (const stack of [this.undoStack, this.redoStack]) {
      let against = op;
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]!;
        const inverse = transform(entry.inverse, against, true);
        against = transform(against, entry.inverse, false);
        entry.inverse = inverse;
      }
    }
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
