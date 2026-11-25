/**
 * The online store editor's undo and redo: a history of whole editor states
 * (the draft document and the content pages open in it). Edits that come in
 * quick succession to the same field (typing a heading) share one undo step.
 */

import type { Section } from '@weldsuite/storefront-theme/catalog';
import type { EditorContent } from './document';

/** Undo steps kept; older ones are dropped. */
export const HISTORY_LIMIT = 100;
/** Edits to the same field within this many milliseconds are one undo step. */
export const COALESCE_MS = 1000;

export interface EditorHistory {
  past: EditorContent[];
  present: EditorContent;
  future: EditorContent[];
  /** The field the last edit changed, while further edits to it may join its undo step. */
  coalesceKey: string | null;
  changedAt: number;
}

export type HistoryAction =
  /** A fresh start: the loaded draft, no history. */
  | { type: 'load'; content: EditorContent }
  /** A content page's sections, read from the API: added without an undo step. */
  | { type: 'loadPage'; pageId: string; sections: Section[] }
  | { type: 'change'; update: (content: EditorContent) => EditorContent; coalesceKey?: string; at?: number }
  | { type: 'undo' }
  | { type: 'redo' };

export function createHistory(content: EditorContent): EditorHistory {
  return { past: [], present: content, future: [], coalesceKey: null, changedAt: 0 };
}

export function historyReducer(state: EditorHistory, action: HistoryAction): EditorHistory {
  switch (action.type) {
    case 'load':
      return createHistory(action.content);
    case 'loadPage': {
      const withPage = (content: EditorContent): EditorContent =>
        action.pageId in content.pages ? content : { ...content, pages: { ...content.pages, [action.pageId]: action.sections } };
      return { ...state, past: state.past.map(withPage), present: withPage(state.present), future: state.future.map(withPage) };
    }
    case 'change': {
      const next = action.update(state.present);
      if (next === state.present) return state;
      const at = action.at ?? Date.now();
      const joins = action.coalesceKey !== undefined && action.coalesceKey === state.coalesceKey && at - state.changedAt < COALESCE_MS;
      return {
        past: joins ? state.past : [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        coalesceKey: action.coalesceKey ?? null,
        changedAt: at,
      };
    }
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], coalesceKey: null, changedAt: 0 };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { past: [...state.past, state.present], present: next, future: rest, coalesceKey: null, changedAt: 0 };
    }
    default:
      return state;
  }
}
