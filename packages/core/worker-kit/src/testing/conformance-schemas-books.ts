/**
 * WeldBooks (books-api) response schemas, by route. Spread into ROUTES by
 * conformance-schemas.ts. The ledger is here; each other books area adds its
 * own list (`conformance-schemas-books-<area>.ts`) and one line below, so the
 * areas don't edit the same lines (plan: rust/modules/books/PORTING.md).
 */
import {
  accountingDimensionValueSchema,
  accountingEntityCreatedSchema,
  accountingEntityDetailSchema,
  accountingEntitySchema,
  accountingEntityUpdatedSchema,
  accountingInboxSchema,
  accountingSettingsSchema,
  booksIdResultSchema,
  exchangeRateSchema,
  exchangeRatesSchema,
  fiscalCalendarSchema,
  fiscalPeriodSchema,
  fiscalPeriodStatusSchema,
  fiscalPeriodsGeneratedSchema,
  fxRateSchema,
  glAccountSchema,
  glAccountTransactionSchema,
  journalEntryCreatedSchema,
  journalEntryDetailSchema,
  journalEntryReversalSchema,
  journalEntrySchema,
  jurisdictionSummarySchema,
  lockDateExceptionSchema,
  postingCatchUpSchema,
  revealedSsnSchema,
  seededWorkflowTemplatesSchema,
  taxLineCatalogSchema,
  taxLineRemapSchema,
  taxRateSchema,
} from '@weldsuite/app-api-client/schemas/books-responses';
import type { RouteSchema } from './conformance-schemas';
import { BOOKS_SALES_ROUTES } from './conformance-schemas-books-sales';
import { BOOKS_BANKING_ROUTES } from './conformance-schemas-books-banking';
import { BOOKS_PURCHASES_ROUTES } from './conformance-schemas-books-purchases';
import { BOOKS_SALES_TAX_ROUTES } from './conformance-schemas-books-sales-tax';

/** The ledger: entities, settings, GL accounts, journal entries, fiscal periods, tax rates, FX rates, dimensions. */
const BOOKS_LEDGER_ROUTES: RouteSchema[] = [
  // fx-rates
  { method: 'GET', route: '/api/fx-rates', envelope: 'list', data: fxRateSchema },
  { method: 'GET', route: '/api/fx-rates/:id', envelope: 'single', data: fxRateSchema },
  { method: 'POST', route: '/api/fx-rates', envelope: 'single', data: booksIdResultSchema },
  { method: 'PATCH', route: '/api/fx-rates/:id', envelope: 'single', data: booksIdResultSchema },
  // accounting-dimensions
  { method: 'GET', route: '/api/accounting-dimensions', envelope: 'list', data: accountingDimensionValueSchema },
  { method: 'GET', route: '/api/accounting-dimensions/:id', envelope: 'single', data: accountingDimensionValueSchema },
  { method: 'POST', route: '/api/accounting-dimensions', envelope: 'single', data: accountingDimensionValueSchema },
  { method: 'PATCH', route: '/api/accounting-dimensions/:id', envelope: 'single', data: accountingDimensionValueSchema },
  // journal-entries
  { method: 'GET', route: '/api/journal-entries', envelope: 'list', data: journalEntrySchema },
  { method: 'GET', route: '/api/journal-entries/:id', envelope: 'single', data: journalEntryDetailSchema },
  { method: 'POST', route: '/api/journal-entries', envelope: 'single', data: journalEntryCreatedSchema },
  { method: 'PATCH', route: '/api/journal-entries/:id', envelope: 'single', data: booksIdResultSchema },
  { method: 'POST', route: '/api/journal-entries/:id/post', envelope: 'single', data: journalEntrySchema },
  { method: 'POST', route: '/api/journal-entries/:id/reverse', envelope: 'single', data: journalEntryReversalSchema },
  // fiscal-periods
  { method: 'GET', route: '/api/fiscal-periods', envelope: 'list', data: fiscalPeriodSchema },
  { method: 'GET', route: '/api/fiscal-periods/calendar', envelope: 'single', data: fiscalCalendarSchema },
  { method: 'POST', route: '/api/fiscal-periods/generate', envelope: 'single', data: fiscalPeriodsGeneratedSchema },
  { method: 'GET', route: '/api/fiscal-periods/:id', envelope: 'single', data: fiscalPeriodSchema },
  { method: 'POST', route: '/api/fiscal-periods', envelope: 'single', data: booksIdResultSchema },
  { method: 'PATCH', route: '/api/fiscal-periods/:id', envelope: 'single', data: booksIdResultSchema },
  { method: 'POST', route: '/api/fiscal-periods/:id/close', envelope: 'single', data: fiscalPeriodStatusSchema },
  { method: 'POST', route: '/api/fiscal-periods/:id/reopen', envelope: 'single', data: fiscalPeriodStatusSchema },
  // accounting-entities
  { method: 'GET', route: '/api/accounting-entities', envelope: 'array', data: accountingEntitySchema },
  { method: 'GET', route: '/api/accounting-entities/jurisdictions', envelope: 'array', data: jurisdictionSummarySchema },
  { method: 'GET', route: '/api/accounting-entities/:id', envelope: 'single', data: accountingEntityDetailSchema },
  { method: 'POST', route: '/api/accounting-entities', envelope: 'single', data: accountingEntityCreatedSchema },
  { method: 'PATCH', route: '/api/accounting-entities/:id', envelope: 'single', data: accountingEntityUpdatedSchema },
  { method: 'POST', route: '/api/accounting-entities/:id/apply-tax-lines', envelope: 'single', data: taxLineRemapSchema },
  { method: 'POST', route: '/api/accounting-entities/:id/reveal-ssn', envelope: 'single', data: revealedSsnSchema },
  { method: 'PATCH', route: '/api/accounting-entities/:id/lock-dates', envelope: 'single', data: accountingEntitySchema },
  { method: 'GET', route: '/api/accounting-entities/:id/lock-exceptions', envelope: 'array', data: lockDateExceptionSchema },
  { method: 'POST', route: '/api/accounting-entities/:id/lock-exceptions', envelope: 'single', data: lockDateExceptionSchema },
  { method: 'POST', route: '/api/accounting-entities/:id/lock-exceptions/:exceptionId/revoke', envelope: 'single', data: lockDateExceptionSchema },
  // gl-accounts
  { method: 'GET', route: '/api/gl-accounts/tax-lines', envelope: 'single', data: taxLineCatalogSchema },
  { method: 'GET', route: '/api/gl-accounts', envelope: 'array', data: glAccountSchema },
  { method: 'GET', route: '/api/gl-accounts/:id', envelope: 'single', data: glAccountSchema },
  { method: 'GET', route: '/api/gl-accounts/:id/transactions', envelope: 'list', data: glAccountTransactionSchema },
  { method: 'POST', route: '/api/gl-accounts', envelope: 'single', data: glAccountSchema },
  { method: 'PATCH', route: '/api/gl-accounts/:id', envelope: 'single', data: glAccountSchema },
  { method: 'PUT', route: '/api/gl-accounts/:id', envelope: 'single', data: glAccountSchema },
  // tax-rates
  { method: 'GET', route: '/api/tax-rates', envelope: 'array', data: taxRateSchema },
  { method: 'GET', route: '/api/tax-rates/:id', envelope: 'single', data: taxRateSchema },
  { method: 'POST', route: '/api/tax-rates', envelope: 'single', data: taxRateSchema },
  { method: 'PATCH', route: '/api/tax-rates/:id', envelope: 'single', data: taxRateSchema },
  { method: 'PUT', route: '/api/tax-rates/:id', envelope: 'single', data: taxRateSchema },
  // accounting-settings
  { method: 'GET', route: '/api/accounting-settings', envelope: 'single', data: accountingSettingsSchema },
  { method: 'PUT', route: '/api/accounting-settings', envelope: 'single', data: accountingSettingsSchema },
  { method: 'PATCH', route: '/api/accounting-settings', envelope: 'single', data: accountingSettingsSchema },
  { method: 'GET', route: '/api/accounting-settings/exchange-rates', envelope: 'single', data: exchangeRatesSchema },
  { method: 'GET', route: '/api/accounting-settings/exchange-rate/:from/:to', envelope: 'single', data: exchangeRateSchema },
  { method: 'POST', route: '/api/accounting-settings/inbox', envelope: 'single', data: accountingInboxSchema },
  { method: 'POST', route: '/api/accounting-settings/seed-workflows', envelope: 'single', data: seededWorkflowTemplatesSchema },
  { method: 'POST', route: '/api/accounting-settings/posting-catch-up', envelope: 'single', data: postingCatchUpSchema },
];

export const BOOKS_ROUTES: RouteSchema[] = [
  ...BOOKS_LEDGER_ROUTES,
  ...BOOKS_SALES_ROUTES,
  ...BOOKS_BANKING_ROUTES,
  ...BOOKS_PURCHASES_ROUTES,
  ...BOOKS_SALES_TAX_ROUTES,
  // ...BOOKS_<AREA>_ROUTES, (one line per area)
];
