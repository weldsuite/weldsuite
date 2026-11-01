/**
 * WeldBooks banking (books-api) response schemas, by route: bank accounts,
 * transactions and import, reconciliation rules, deposits, statement
 * reconciliations and bank-feed connections. Spread into BOOKS_ROUTES by
 * conformance-schemas-books.ts (plan: rust/modules/books/PORTING.md).
 */
import {
  autoReconcileResultSchema,
  bankAccountSchema,
  bankLineExcludedSchema,
  bankLineMatchSchema,
  bankTransactionSchema,
  createdBankAccountSchema,
  createdBankTransactionSchema,
  importPreviewSchema,
  importResultSchema,
  matchSuggestionSchema,
  reconciliationRuleSchema,
  revealedAccountNumberSchema,
} from '@weldsuite/app-api-client/schemas/books-banking-responses';
import type { RouteSchema } from './conformance-schemas';

export const BOOKS_BANKING_ROUTES: RouteSchema[] = [
  // bank-accounts
  { method: 'GET', route: '/api/bank-accounts', envelope: 'array', data: bankAccountSchema },
  { method: 'GET', route: '/api/bank-accounts/:id', envelope: 'single', data: bankAccountSchema },
  { method: 'POST', route: '/api/bank-accounts', envelope: 'single', data: createdBankAccountSchema },
  { method: 'PATCH', route: '/api/bank-accounts/:id', envelope: 'single', data: bankAccountSchema },
  { method: 'PUT', route: '/api/bank-accounts/:id', envelope: 'single', data: bankAccountSchema },
  { method: 'POST', route: '/api/bank-accounts/:id/reveal-account-number', envelope: 'single', data: revealedAccountNumberSchema },
  // bank-transactions
  { method: 'GET', route: '/api/bank-transactions', envelope: 'list', data: bankTransactionSchema },
  { method: 'GET', route: '/api/bank-transactions/unreconciled', envelope: 'array', data: bankTransactionSchema },
  { method: 'GET', route: '/api/bank-transactions/:id', envelope: 'single', data: bankTransactionSchema },
  { method: 'POST', route: '/api/bank-transactions', envelope: 'single', data: createdBankTransactionSchema },
  { method: 'POST', route: '/api/bank-transactions/import/preview', envelope: 'single', data: importPreviewSchema },
  { method: 'POST', route: '/api/bank-transactions/import', envelope: 'single', data: importResultSchema },
  { method: 'POST', route: '/api/bank-transactions/auto-reconcile', envelope: 'single', data: autoReconcileResultSchema },
  { method: 'GET', route: '/api/bank-transactions/:id/suggestions', envelope: 'array', data: matchSuggestionSchema },
  { method: 'POST', route: '/api/bank-transactions/:id/match-deposit', envelope: 'single', data: bankLineMatchSchema },
  { method: 'POST', route: '/api/bank-transactions/:id/match-payment', envelope: 'single', data: bankLineMatchSchema },
  { method: 'POST', route: '/api/bank-transactions/:id/reconcile', envelope: 'single', data: bankLineMatchSchema },
  { method: 'POST', route: '/api/bank-transactions/:id/unreconcile', envelope: 'single', data: bankLineMatchSchema },
  { method: 'POST', route: '/api/bank-transactions/:id/exclude', envelope: 'single', data: bankLineExcludedSchema },
  // reconciliation-rules
  { method: 'GET', route: '/api/reconciliation-rules', envelope: 'array', data: reconciliationRuleSchema },
  { method: 'GET', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'POST', route: '/api/reconciliation-rules', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'PATCH', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'PUT', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
];
