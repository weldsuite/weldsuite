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
  seededWorkflowTemplatesSchema,
  taxRateSchema,
} from '@weldsuite/app-api-client/schemas/books-responses';
import type { RouteSchema } from './conformance-schemas';

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
];

// Referenced by the routes added as their groups are ported.
void [
  accountingEntityCreatedSchema,
  accountingEntityDetailSchema,
  accountingEntitySchema,
  accountingInboxSchema,
  accountingSettingsSchema,
  exchangeRateSchema,
  exchangeRatesSchema,
  glAccountSchema,
  glAccountTransactionSchema,
  jurisdictionSummarySchema,
  lockDateExceptionSchema,
  postingCatchUpSchema,
  seededWorkflowTemplatesSchema,
  taxRateSchema,
];

export const BOOKS_ROUTES: RouteSchema[] = [
  ...BOOKS_LEDGER_ROUTES,
  // ...BOOKS_SALES_ROUTES, (one line per area)
];
