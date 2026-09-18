/**
 * useBooksRealtime — workspace-hub accounting events for weldbooks-app.
 *
 * Phase 8: shell mounts useRealtimeSync(weldbooksSyncMap). This hook listens
 * for QueryClient invalidations on the matching accounting prefixes and maps
 * them back to UI surfaces (invoices / bills / dashboard / …).
 */

import { useCallback } from 'react';
import { useQueryKeyInvalidation } from '@weldsuite/mobile-realtime';
import { booksKeys } from '@/lib/sync-map';
import {
  type BooksRealtimeHandlers,
  type BooksRealtimeSurface,
} from './books-realtime-dispatch';

export type { BooksRealtimeSurface, BooksRealtimeHandlers };
export {
  BOOKS_HUB_TOPICS,
  dispatchBooksRealtimeEvent,
  surfacesForBooksTopic,
} from './books-realtime-dispatch';

interface UseBooksRealtimeOptions extends BooksRealtimeHandlers {
  /** When false, skip subscription (e.g. signed-out). Default true. */
  enabled?: boolean;
}

const SURFACE_PREFIXES: Record<
  Exclude<BooksRealtimeSurface, 'any'>,
  readonly (readonly unknown[])[]
> = {
  invoices: [booksKeys.invoices()],
  bills: [booksKeys.bills()],
  dashboard: [booksKeys.dashboard()],
  banking: [booksKeys.bankAccounts(), booksKeys.bankTransactions()],
  contacts: [booksKeys.contacts()],
  vat: [booksKeys.vatReturns()],
  reports: [booksKeys.reports()],
};

const ANY_PREFIXES: readonly (readonly unknown[])[] = [booksKeys.all];

export function useBooksRealtime(options: UseBooksRealtimeOptions): void {
  const { enabled = true, onInvalidate } = options;

  const fire = useCallback(
    (surface: BooksRealtimeSurface) => {
      onInvalidate?.(surface);
    },
    [onInvalidate],
  );

  const onInvoices = useCallback(() => fire('invoices'), [fire]);
  const onBills = useCallback(() => fire('bills'), [fire]);
  const onDashboard = useCallback(() => fire('dashboard'), [fire]);
  const onBanking = useCallback(() => fire('banking'), [fire]);
  const onContacts = useCallback(() => fire('contacts'), [fire]);
  const onVat = useCallback(() => fire('vat'), [fire]);
  const onReports = useCallback(() => fire('reports'), [fire]);
  const onAny = useCallback(() => fire('any'), [fire]);

  useQueryKeyInvalidation(SURFACE_PREFIXES.invoices, onInvoices, enabled);
  useQueryKeyInvalidation(SURFACE_PREFIXES.bills, onBills, enabled);
  useQueryKeyInvalidation(SURFACE_PREFIXES.dashboard, onDashboard, enabled);
  useQueryKeyInvalidation(SURFACE_PREFIXES.banking, onBanking, enabled);
  useQueryKeyInvalidation(SURFACE_PREFIXES.contacts, onContacts, enabled);
  useQueryKeyInvalidation(SURFACE_PREFIXES.vat, onVat, enabled);
  useQueryKeyInvalidation(SURFACE_PREFIXES.reports, onReports, enabled);
  useQueryKeyInvalidation(ANY_PREFIXES, onAny, enabled);
}
