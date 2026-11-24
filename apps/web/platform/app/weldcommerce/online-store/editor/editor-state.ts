/**
 * Client state of the online store editor, in Jotai atoms that live in a
 * store scoped to one editor (`<Provider>` in the page): the document
 * history (undo and redo), the selected section, block or settings panel,
 * the preview width, and the draft's last save errors.
 */

import { atom, useAtomValue, useSetAtom } from 'jotai';
import type { TemplateName } from '@weldsuite/storefront-theme/catalog';
import { createHistory, historyReducer, type EditorHistory, type HistoryAction } from '../lib/history';
import type { EditorContent, ListKey } from '../lib/document';

export type DeviceWidth = 'phone' | 'tablet' | 'desktop';

/** Preview widths in CSS pixels; the desktop preview fills the space. */
export const DEVICE_WIDTHS: Record<DeviceWidth, number | null> = { phone: 390, tablet: 820, desktop: null };

/** What the left panel's middle list shows: a template, or a content page's own sections. */
export type EditorView = { kind: 'template'; template: TemplateName } | { kind: 'page'; pageId: string };

export type EditorSelection =
  | { kind: 'section'; list: ListKey; sectionId: string; blockId?: string }
  | { kind: 'theme' }
  | { kind: 'shop' }
  | null;

export const historyAtom = atom<EditorHistory | null>(null);

export const dispatchAtom = atom(null, (get, set, action: HistoryAction) => {
  const state = get(historyAtom);
  if (!state) {
    if (action.type === 'load') set(historyAtom, createHistory(action.content));
    return;
  }
  set(historyAtom, historyReducer(state, action));
});

export const selectionAtom = atom<EditorSelection>(null);
export const deviceAtom = atom<DeviceWidth>('desktop');
/** The field errors of the last refused save (document path → message). */
export const fieldErrorsAtom = atom<Record<string, string>>({});

export function useEditorHistory(): EditorHistory {
  const history = useAtomValue(historyAtom);
  if (!history) throw new Error('The online store editor state is used outside its provider.');
  return history;
}

export function useEditorContent(): EditorContent {
  return useEditorHistory().present;
}

export function useEditorDispatch() {
  return useSetAtom(dispatchAtom);
}

export function viewListKey(view: EditorView): ListKey {
  return view.kind === 'page' ? { name: 'content', pageId: view.pageId } : { name: view.template };
}
