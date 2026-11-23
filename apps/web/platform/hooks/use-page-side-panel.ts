import { useEffect, useSyncExternalStore } from 'react';

/**
 * Whether the page shows a side panel of its own, in its layout rather than
 * on the object-panel stack: the WeldDesk inbox's customer panel beside the
 * thread.
 *
 * Opening WeldAgent puts the agent in that space instead: the page hides its
 * panel while the agent is open, and the agent appears without its slide-in,
 * as when it replaces the calendar or notifications drawer (one panel at a
 * time).
 */

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read outside React: is a page side panel showing right now? */
export function isPageSidePanelOpen(): boolean {
  return open;
}

export function usePageSidePanelOpen(): boolean {
  return useSyncExternalStore(subscribe, isPageSidePanelOpen, () => false);
}

/** Marks the page's side panel as showing while `showing` is true and the caller is mounted. */
export function useReportPageSidePanel(showing: boolean): void {
  useEffect(() => {
    if (!showing) return;
    setOpen(true);
    return () => setOpen(false);
  }, [showing]);
}
