/**
 * Mobile EntitySyncMap for weldbooks-app — accounting prefixes align with
 * platform Books keys under `['accounting', …]`.
 *
 * Lists still use imperative `usePagedList`; screens listen via
 * `useQueryKeyInvalidation` after RealtimeSyncBridge seeds these prefixes.
 */

import { inv, type EntitySyncMap } from '@weldsuite/realtime/react';

export const booksKeys = {
  all: ['accounting'] as const,
  invoices: () => [...booksKeys.all, 'invoices'] as const,
  bills: () => [...booksKeys.all, 'bills'] as const,
  payments: () => [...booksKeys.all, 'payments'] as const,
  dashboard: () => [...booksKeys.all, 'dashboard'] as const,
  reports: () => [...booksKeys.all, 'reports'] as const,
  documents: () => [...booksKeys.all, 'documents'] as const,
  contacts: () => [...booksKeys.all, 'customers'] as const,
  bankAccounts: () => [...booksKeys.all, 'bank-accounts'] as const,
  bankTransactions: () => [...booksKeys.all, 'bank-transactions'] as const,
  vatReturns: () => [...booksKeys.all, 'vat-returns'] as const,
  accounts: () => [...booksKeys.all, 'accounts'] as const,
  entities: () => [...booksKeys.all, 'entities'] as const,
  journalEntries: () => [...booksKeys.all, 'journal-entries'] as const,
};

export const weldbooksSyncMap: EntitySyncMap = {
  invoice: inv(
    booksKeys.invoices(),
    booksKeys.payments(),
    booksKeys.dashboard(),
    booksKeys.reports(),
  ),
  bill: inv(
    booksKeys.bills(),
    booksKeys.payments(),
    booksKeys.dashboard(),
    booksKeys.documents(),
  ),
  payment: inv(
    booksKeys.payments(),
    booksKeys.invoices(),
    booksKeys.bills(),
    booksKeys.dashboard(),
  ),
  accounting_document: inv(booksKeys.documents(), booksKeys.bills(), booksKeys.dashboard()),
  accounting_contact: inv(booksKeys.contacts()),
  bank_account: inv(booksKeys.bankAccounts(), booksKeys.dashboard()),
  bank_transaction: inv(booksKeys.bankTransactions(), booksKeys.dashboard()),
  journal_entry: inv(booksKeys.journalEntries(), booksKeys.dashboard(), booksKeys.reports()),
  vat_return: inv(booksKeys.vatReturns(), booksKeys.dashboard()),
  account: inv(booksKeys.accounts(), booksKeys.dashboard(), booksKeys.reports()),
  accounting_entity: inv(booksKeys.entities()),
};
