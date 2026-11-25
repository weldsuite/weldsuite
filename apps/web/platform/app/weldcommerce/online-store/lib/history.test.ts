import { describe, expect, it } from 'vitest';
import { defaultSiteDocument } from '@weldsuite/storefront-theme/catalog';
import { COALESCE_MS, HISTORY_LIMIT, createHistory, historyReducer, type EditorHistory } from './history';
import type { EditorContent } from './document';

const start = (): EditorContent => ({ document: defaultSiteDocument(), pages: {} });
const withTitle = (title: string) => (content: EditorContent): EditorContent => ({ ...content, document: { ...content.document, seo: { title } } });
const title = (state: EditorHistory) => state.present.document.seo.title;

describe('editor history', () => {
  it('undoes and redoes changes, and a new change drops the redo steps', () => {
    let state = createHistory(start());
    state = historyReducer(state, { type: 'change', update: withTitle('A'), at: 0 });
    state = historyReducer(state, { type: 'change', update: withTitle('B'), at: 5000 });
    expect(title(state)).toBe('B');
    state = historyReducer(state, { type: 'undo' });
    expect(title(state)).toBe('A');
    state = historyReducer(state, { type: 'undo' });
    expect(title(state)).toBeUndefined();
    expect(historyReducer(state, { type: 'undo' })).toBe(state);
    state = historyReducer(state, { type: 'redo' });
    expect(title(state)).toBe('A');
    state = historyReducer(state, { type: 'change', update: withTitle('C'), at: 9000 });
    expect(state.future).toEqual([]);
    expect(historyReducer(state, { type: 'redo' })).toBe(state);
  });

  it('makes quick edits to the same field one undo step', () => {
    let state = createHistory(start());
    state = historyReducer(state, { type: 'change', update: withTitle('S'), coalesceKey: 'seo', at: 1000 });
    state = historyReducer(state, { type: 'change', update: withTitle('Sp'), coalesceKey: 'seo', at: 1200 });
    state = historyReducer(state, { type: 'change', update: withTitle('Spr'), coalesceKey: 'seo', at: 1400 });
    expect(state.past).toHaveLength(1);
    // A pause, or another field, starts a new step.
    state = historyReducer(state, { type: 'change', update: withTitle('Spri'), coalesceKey: 'seo', at: 1400 + COALESCE_MS + 1 });
    state = historyReducer(state, { type: 'change', update: withTitle('Sprin'), coalesceKey: 'other', at: 1400 + COALESCE_MS + 2 });
    expect(state.past).toHaveLength(3);
    state = historyReducer(state, { type: 'undo' });
    state = historyReducer(state, { type: 'undo' });
    state = historyReducer(state, { type: 'undo' });
    expect(title(state)).toBeUndefined();
  });

  it('ignores a change that changes nothing', () => {
    const state = createHistory(start());
    expect(historyReducer(state, { type: 'change', update: (content) => content })).toBe(state);
  });

  it('keeps a bounded number of undo steps', () => {
    let state = createHistory(start());
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) state = historyReducer(state, { type: 'change', update: withTitle(String(i)), at: i * 10_000 });
    expect(state.past).toHaveLength(HISTORY_LIMIT);
  });

  it('adds a loaded page to every step without an undo step of its own, and a load starts over', () => {
    let state = createHistory(start());
    state = historyReducer(state, { type: 'change', update: withTitle('A'), at: 0 });
    state = historyReducer(state, { type: 'loadPage', pageId: 'pg_1', sections: [] });
    expect(state.past).toHaveLength(1);
    expect(state.past[0]!.pages.pg_1).toEqual([]);
    expect(state.present.pages.pg_1).toEqual([]);
    state = historyReducer(state, { type: 'load', content: start() });
    expect(state.past).toEqual([]);
    expect(title(state)).toBeUndefined();
  });
});
