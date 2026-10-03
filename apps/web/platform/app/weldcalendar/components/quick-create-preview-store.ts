import { useSyncExternalStore } from 'react';

/**
 * Title typed in the open quick-create card, so the preview block it leaves on
 * the time grid shows it live instead of "(No title)". A tiny external store:
 * the card and the grid views are far apart in the tree and the views are
 * shared with other callers, so this avoids threading a prop through all of them.
 */
let previewTitle = '';
const listeners = new Set<() => void>();

export function setQuickCreatePreviewTitle(title: string): void {
  if (title === previewTitle) return;
  previewTitle = title;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string {
  return previewTitle;
}

/** The title currently typed in the quick-create card ('' when none). */
export function useQuickCreatePreviewTitle(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
