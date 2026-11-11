/**
 * Undo and redo for the builder's draft. Pure: the editor context holds one
 * `History<Draft>` in a reducer-like state and calls these.
 *
 * Edits that share a `coalesceKey` within `COALESCE_MS` of each other (typing
 * in one title, dragging one slider) become a single undo step.
 */

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 1000;

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Key and time of the last commit, for coalescing. */
  lastKey: string | null;
  lastAt: number;
}

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastAt: 0 };
}

export interface CommitOptions {
  coalesceKey?: string;
  now?: number;
}

/** Makes `next` the present. An unchanged value (same reference) is a no-op. */
export function commit<T>(history: History<T>, next: T, options: CommitOptions = {}): History<T> {
  if (Object.is(next, history.present)) return history;
  const now = options.now ?? Date.now();
  const key = options.coalesceKey ?? null;
  const coalesce = key !== null && key === history.lastKey && now - history.lastAt <= COALESCE_MS && history.past.length > 0;
  const past = coalesce ? history.past : [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastKey: null,
    lastAt: 0,
  };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest, lastKey: null, lastAt: 0 };
}

/** Replaces the present without a history step (the server's copy after a save or a reload). */
export function replacePresent<T>(history: History<T>, present: T): History<T> {
  return { ...history, present };
}

/** Starts over on a new value (the form was reloaded after a conflict). */
export function reset<T>(present: T): History<T> {
  return createHistory(present);
}
