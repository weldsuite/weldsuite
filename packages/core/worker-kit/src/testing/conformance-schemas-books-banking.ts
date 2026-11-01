/**
 * WeldBooks banking (books-api) response schemas, by route: bank accounts,
 * transactions and import, reconciliation rules, deposits, statement
 * reconciliations and bank-feed connections. Spread into BOOKS_ROUTES by
 * conformance-schemas-books.ts (plan: rust/modules/books/PORTING.md).
 */
import {
  autoReconcileResultSchema,
  bankAccountSchema,
  bankConnectionSchema,
  bankDepositDetailSchema,
  bankDepositSchema,
  bankFeedInstitutionSchema,
  bankFeedLinkSessionSchema,
  bankFeedPendingTransactionSchema,
  bankFeedProvidersSchema,
  bankLineExcludedSchema,
  bankLineMatchSchema,
  bankTransactionSchema,
  createdBankAccountSchema,
  createdBankDepositSchema,
  createdBankTransactionSchema,
  completedBankLinkSchema,
  importPreviewSchema,
  importResultSchema,
  mappedBankFeedAccountsSchema,
  matchSuggestionSchema,
  reconciliationHistorySchema,
  reconciliationReportSchema,
  reconciliationRuleSchema,
  reconciliationViewSchema,
  revealedAccountNumberSchema,
  syncedBankConnectionSchema,
  undepositedPaymentSchema,
} from '@weldsuite/app-api-client/schemas/books-banking-responses';
import { bankConnectionBillingSummarySchema } from '@weldsuite/app-api-client/schemas/bank-connection-billing';
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
  // bank-deposits
  { method: 'GET', route: '/api/bank-deposits', envelope: 'list', data: bankDepositSchema },
  { method: 'GET', route: '/api/bank-deposits/undeposited', envelope: 'list', data: undepositedPaymentSchema },
  { method: 'GET', route: '/api/bank-deposits/:id', envelope: 'single', data: bankDepositDetailSchema },
  { method: 'POST', route: '/api/bank-deposits', envelope: 'single', data: createdBankDepositSchema },
  { method: 'PATCH', route: '/api/bank-deposits/:id', envelope: 'single', data: bankDepositSchema },
  // bank-reconciliations
  { method: 'GET', route: '/api/bank-reconciliations', envelope: 'list', data: reconciliationHistorySchema },
  { method: 'POST', route: '/api/bank-reconciliations', envelope: 'single', data: reconciliationViewSchema },
  { method: 'GET', route: '/api/bank-reconciliations/:id', envelope: 'single', data: reconciliationViewSchema },
  { method: 'GET', route: '/api/bank-reconciliations/:id/report', envelope: 'single', data: reconciliationReportSchema },
  { method: 'PATCH', route: '/api/bank-reconciliations/:id', envelope: 'single', data: reconciliationViewSchema },
  { method: 'POST', route: '/api/bank-reconciliations/:id/complete', envelope: 'single', data: reconciliationViewSchema },
  { method: 'POST', route: '/api/bank-reconciliations/:id/undo', envelope: 'single', data: reconciliationViewSchema },
  // reconciliation-rules
  { method: 'GET', route: '/api/reconciliation-rules', envelope: 'array', data: reconciliationRuleSchema },
  { method: 'GET', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'POST', route: '/api/reconciliation-rules', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'PATCH', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'PUT', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
  // bank-connections (bank feeds)
  { method: 'GET', route: '/api/bank-connections', envelope: 'list', data: bankConnectionSchema },
  { method: 'GET', route: '/api/bank-connections/providers', envelope: 'single', data: bankFeedProvidersSchema },
  { method: 'GET', route: '/api/bank-connections/institutions', envelope: 'list', data: bankFeedInstitutionSchema },
  { method: 'GET', route: '/api/bank-connections/billing', envelope: 'single', data: bankConnectionBillingSummarySchema.nullable() },
  { method: 'POST', route: '/api/bank-connections/link-session', envelope: 'single', data: bankFeedLinkSessionSchema },
  { method: 'POST', route: '/api/bank-connections/complete', envelope: 'single', data: completedBankLinkSchema },
  { method: 'POST', route: '/api/bank-connections/:id/map-accounts', envelope: 'single', data: mappedBankFeedAccountsSchema },
  { method: 'POST', route: '/api/bank-connections/:id/sync', envelope: 'single', data: syncedBankConnectionSchema },
  { method: 'POST', route: '/api/bank-connections/:id/disconnect', envelope: 'single', data: bankConnectionSchema },
  { method: 'GET', route: '/api/bank-connections/:id/pending', envelope: 'list', data: bankFeedPendingTransactionSchema },
  { method: 'GET', route: '/api/bank-connections/:id', envelope: 'single', data: bankConnectionSchema },
];
