/**
 * Pure Books hub-event → surface dispatch for weldbooks-app.
 * Kept React-free so it can be unit-tested without jest-expo.
 *
 * Phase 8: the shell mounts useRealtimeSync(weldbooksSyncMap). Screens still
 * use useBooksRealtime, which now listens to QueryClient invalidations mapped
 * from this surface table (lockstep with lib/sync-map.ts).
 */

export type BooksRealtimeSurface =
  | 'invoices'
  | 'bills'
  | 'dashboard'
  | 'banking'
  | 'contacts'
  | 'vat'
  | 'reports'
  | 'any';

export interface BooksRealtimeHandlers {
  /** Fired when a hub event should refresh the given UI surface. */
  onInvalidate?: (surface: BooksRealtimeSurface) => void;
}

/** Hub entity topics that affect the WeldBooks mobile shell. */
export const BOOKS_HUB_TOPICS = [
  'invoice',
  'bill',
  'payment',
  'accounting_document',
  'accounting_contact',
  'bank_account',
  'bank_transaction',
  'journal_entry',
  'vat_return',
  'account',
  'accounting_entity',
] as const;

export type BooksHubTopic = (typeof BOOKS_HUB_TOPICS)[number];

const TOPIC_SURFACES: Record<BooksHubTopic, BooksRealtimeSurface[]> = {
  invoice: ['invoices', 'dashboard', 'reports'],
  bill: ['bills', 'dashboard', 'reports'],
  payment: ['invoices', 'bills', 'dashboard'],
  accounting_document: ['bills', 'dashboard'],
  accounting_contact: ['contacts'],
  bank_account: ['banking', 'dashboard'],
  bank_transaction: ['banking', 'dashboard'],
  journal_entry: ['dashboard', 'reports'],
  vat_return: ['vat', 'dashboard'],
  account: ['dashboard', 'reports'],
  accounting_entity: ['any'],
};

/**
 * Map a hub topic (+ optional event name) to UI surfaces that should reload.
 * Returns [] for unknown topics.
 */
export function surfacesForBooksTopic(topic: string): BooksRealtimeSurface[] {
  const surfaces = TOPIC_SURFACES[topic as BooksHubTopic];
  return surfaces ? [...surfaces] : [];
}

/**
 * Dispatch a hub event to the Books invalidate callback.
 * Always also fires `any` so screens that want "anything accounting" can listen.
 */
export function dispatchBooksRealtimeEvent(
  topic: string,
  _event: string,
  handlers: BooksRealtimeHandlers,
): void {
  const onInvalidate = handlers.onInvalidate;
  if (!onInvalidate) return;

  const surfaces = surfacesForBooksTopic(topic);
  if (surfaces.length === 0) return;

  const seen = new Set<BooksRealtimeSurface>();
  for (const surface of surfaces) {
    if (seen.has(surface)) continue;
    seen.add(surface);
    onInvalidate(surface);
  }
  if (!seen.has('any')) {
    onInvalidate('any');
  }
}
