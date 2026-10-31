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
  fiscalPeriodSchema,
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
];

// Referenced by the routes added as their groups are ported.
void [
  accountingDimensionValueSchema,
  accountingEntityCreatedSchema,
  accountingEntityDetailSchema,
  accountingEntitySchema,
  accountingInboxSchema,
  accountingSettingsSchema,
  exchangeRateSchema,
  exchangeRatesSchema,
  fiscalPeriodSchema,
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
];

export const BOOKS_ROUTES: RouteSchema[] = [
  ...BOOKS_LEDGER_ROUTES,
  // ...BOOKS_SALES_ROUTES, (one line per area)
];
