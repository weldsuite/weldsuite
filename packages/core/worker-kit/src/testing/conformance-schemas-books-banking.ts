/**
 * WeldBooks banking (books-api) response schemas, by route: bank accounts,
 * transactions and import, reconciliation rules, deposits, statement
 * reconciliations and bank-feed connections. Spread into BOOKS_ROUTES by
 * conformance-schemas-books.ts (plan: rust/modules/books/PORTING.md).
 */
import {
  bankAccountSchema,
  createdBankAccountSchema,
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
  // reconciliation-rules
  { method: 'GET', route: '/api/reconciliation-rules', envelope: 'array', data: reconciliationRuleSchema },
  { method: 'GET', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'POST', route: '/api/reconciliation-rules', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'PATCH', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
  { method: 'PUT', route: '/api/reconciliation-rules/:id', envelope: 'single', data: reconciliationRuleSchema },
];
