/**
 * Whether the AI helpers (generate a form, suggest questions, summaries) exist
 * on this deployment. The Kubernetes editions list `forms-ai` as unavailable
 * in their runtime config, so the entry points never show there. A call that
 * still answers 503 `ai_unavailable` (Global without an AI token) hides them
 * for the rest of the session.
 */

import { useSyncExternalStore } from 'react';
import { isFeatureAvailable } from '@/lib/edition';

const STORAGE_KEY = 'weldforms:ai-unavailable';

let unavailable = false;
try {
  unavailable = sessionStorage.getItem(STORAGE_KEY) === '1';
} catch {
  // No storage (private window, SSR): the flag lives for this page load only.
}

const listeners = new Set<() => void>();

/** Called when a call answered 503 `ai_unavailable`. */
export function markAiUnavailable(): void {
  if (unavailable) return;
  unavailable = true;
  try {
    sessionStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Ignored: see above.
  }
  for (const listener of listeners) listener();
}

export function useAiAvailable(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => !unavailable && isFeatureAvailable('forms-ai'),
    () => true,
  );
}
