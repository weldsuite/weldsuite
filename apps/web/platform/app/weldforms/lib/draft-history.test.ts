import { describe, expect, it } from 'vitest';
import { COALESCE_MS, HISTORY_LIMIT, canRedo, canUndo, commit, createHistory, redo, undo } from './draft-history';

describe('draft history', () => {
  it('undoes and redoes edits in order', () => {
    let h = createHistory('a');
    h = commit(h, 'b', { now: 0 });
    h = commit(h, 'c', { now: 10_000 });
    expect(h.present).toBe('c');
    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    expect(h.present).toBe('b');
    expect(canRedo(h)).toBe(true);
  });

  it('drops the redo stack when a new edit follows an undo', () => {
    let h = commit(createHistory('a'), 'b', { now: 0 });
    h = undo(h);
    h = commit(h, 'x', { now: 5_000 });
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe('x');
  });

  it('treats an unchanged value as no edit', () => {
    const h = createHistory({ n: 1 });
    expect(commit(h, h.present)).toBe(h);
  });

  it('coalesces edits with the same key close together into one step', () => {
    let h = createHistory('');
    h = commit(h, 'h', { coalesceKey: 'title', now: 0 });
    h = commit(h, 'he', { coalesceKey: 'title', now: 200 });
    h = commit(h, 'hel', { coalesceKey: 'title', now: 400 });
    expect(h.past).toEqual(['']);
    expect(undo(h).present).toBe('');
  });

  it('starts a new step for another key or after the window', () => {
    let h = createHistory('');
    h = commit(h, 'a', { coalesceKey: 'title', now: 0 });
    h = commit(h, 'ab', { coalesceKey: 'description', now: 100 });
    h = commit(h, 'abc', { coalesceKey: 'description', now: 100 + COALESCE_MS + 1 });
    expect(h.past).toEqual(['', 'a', 'ab']);
  });

  it('keeps at most HISTORY_LIMIT steps', () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = commit(h, i, { now: i * 10_000 });
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(20);
  });

  it('does nothing when there is nothing to undo or redo', () => {
    const h = createHistory('a');
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});
