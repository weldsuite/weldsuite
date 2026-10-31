/**
 * Response shapes of books-api (WeldBooks): the ledger (accounting entities,
 * settings, GL accounts, journal entries, fiscal periods, tax rates, FX rates,
 * dimensions). The other books areas add their own files next to this one.
 *
 * The platform and the WeldBooks app read these through TypeScript interfaces
 * (`apps/web/platform/lib/api/domains/weldbooks*.ts`); these Zod schemas mirror
 * them so the Rust backend's answers are checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-books.ts`). Rows
 * are `.passthrough()`: the routes answer whole table rows, and the schemas pin
 * the fields the clients read. Drizzle reads `numeric` columns as strings and
 * `timestamp` columns as ISO strings; `date` columns are `YYYY-MM-DD`.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
/** A Drizzle `numeric` column. */
const numericText = z.string();
const nullableNumericText = z.string().nullable();

/** `{ id }`: what most creates and updates answer. */
export const booksIdResultSchema = z.object({ id: z.string() });

// ── fx rates ────────────────────────────────────────────────────────────────

/** An `fx_rates` row. */
export const fxRateSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    date: z.string(),
    fromCurrency: z.string(),
    toCurrency: z.string(),
    rate: numericText,
    source: z.string(),
  })
  .passthrough();

// ── tax rates ───────────────────────────────────────────────────────────────

/** A `tax_rates` row. */
export const taxRateSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    name: z.string(),
    rate: numericText,
    type: z.string().nullable(),
    jurisdictionCode: z.string().nullable(),
    taxCategoryCode: nullableString,
    isDefault: z.boolean().nullable(),
    isActive: z.boolean().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

// ── fiscal periods ──────────────────────────────────────────────────────────

/** A `fiscal_periods` row. */
export const fiscalPeriodSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    name: z.string(),
    type: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    status: z.string(),
    closedAt: nullableString,
    closedBy: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** `POST /api/fiscal-periods/:id/close` and `/reopen`. */
export const fiscalPeriodStatusSchema = z.object({ id: z.string(), status: z.enum(['open', 'closed']) });

/** One period of `GET /api/fiscal-periods/calendar`. */
export const plannedFiscalPeriodSchema = z.object({
  name: z.string(),
  type: z.enum(['month', 'period', 'quarter', 'year']),
  startDate: z.string(),
  endDate: z.string(),
  number: z.number().int().nullable(),
  weeks: z.number().int().nullable(),
  existingId: nullableString,
  existingStatus: nullableString,
  closedAt: nullableString,
  locked: z.boolean(),
});

/** `GET /api/fiscal-periods/calendar`. */
export const fiscalCalendarSchema = z.object({
  fiscalYear: z.number().int(),
  startDate: z.string(),
  endDate: z.string(),
  kind: z.enum(['month', 'fifty_two_fifty_three']),
  weeks: z.number().int().nullable(),
  entityId: z.string(),
  periods: z.array(plannedFiscalPeriodSchema),
});

/** `POST /api/fiscal-periods/generate`. */
export const fiscalPeriodsGeneratedSchema = z.object({
  entityId: z.string(),
  fiscalYear: z.number().int(),
  startDate: z.string(),
  endDate: z.string(),
  kind: z.enum(['month', 'fifty_two_fifty_three']),
  weeks: z.number().int().nullable(),
  created: z.array(fiscalPeriodSchema.omit({ closedAt: true, closedBy: true })),
  skipped: z.array(z.object({ name: z.string(), startDate: z.string(), endDate: z.string() })),
});

// ── GL accounts ─────────────────────────────────────────────────────────────

/** An `accounts` row (the chart of accounts). */
export const glAccountSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    code: z.string(),
    name: z.string(),
    type: z.string(),
    subtype: nullableString,
    parentAccountId: nullableString,
    normalSide: z.string().nullable(),
    currentBalance: nullableNumericText,
    isActive: z.boolean().nullable(),
    isSystemAccount: z.boolean().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** A posted journal line on an account (`GET /api/gl-accounts/:id/transactions`). */
export const glAccountTransactionSchema = z
  .object({
    id: z.string(),
    journalEntryId: z.string(),
    description: nullableString,
    debit: nullableNumericText,
    credit: nullableNumericText,
    contactId: nullableString,
    entryNumber: nullableString,
    entryDate: z.string(),
    entryDescription: nullableString,
    sourceType: nullableString,
  })
  .passthrough();

// ── journal entries ─────────────────────────────────────────────────────────

/** A `journal_lines` row. */
export const journalLineSchema = z
  .object({
    id: z.string(),
    journalEntryId: z.string(),
    accountId: z.string(),
    description: nullableString,
    debit: nullableNumericText,
    credit: nullableNumericText,
  })
  .passthrough();

/** A `journal_entries` row. */
export const journalEntrySchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    entryNumber: nullableString,
    date: z.string(),
    status: z.string(),
    description: nullableString,
    reference: nullableString,
    totalDebit: nullableNumericText,
    totalCredit: nullableNumericText,
    sourceType: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** `GET /api/journal-entries/:id`: the entry with its lines. */
export const journalEntryDetailSchema = journalEntrySchema.extend({ lines: z.array(journalLineSchema) });

/** `POST /api/journal-entries`: the draft's id, number and lines. */
export const journalEntryCreatedSchema = z.object({
  id: z.string(),
  entryNumber: z.string(),
  lines: z.array(journalLineSchema),
});

/** `POST /api/journal-entries/:id/reverse`: the reversal. */
export const journalEntryReversalSchema = z.object({ id: z.string().nullable(), entryNumber: z.string().nullable() });

// ── accounting dimensions ───────────────────────────────────────────────────

/** An `accounting_dimension_values` row (a class or a location). */
export const accountingDimensionValueSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    dimension: z.string(),
    name: z.string(),
    parentId: nullableString,
    isActive: z.boolean().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

// ── accounting settings ─────────────────────────────────────────────────────

/** The `settings` row (one per workspace). */
export const accountingSettingsSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** `GET /api/accounting-settings/exchange-rates`. */
export const exchangeRatesSchema = z.object({
  rates: z.record(z.number()),
  currencies: z.array(z.object({ code: z.string(), name: z.string(), symbol: z.string() })),
  baseCurrency: z.string(),
  fetchedAt: z.string(),
});

/** `GET /api/accounting-settings/exchange-rate/:from/:to`. */
export const exchangeRateSchema = z.object({
  from: z.string(),
  to: z.string(),
  rate: z.number(),
  fetchedAt: z.string(),
});

/** `POST /api/accounting-settings/inbox`. */
export const accountingInboxSchema = z.object({ email: z.string(), accountId: z.string() });

/** `POST /api/accounting-settings/seed-workflows`. */
export const seededWorkflowTemplatesSchema = z.object({ templatesCreated: z.number().int() });

/** `POST /api/accounting-settings/posting-catch-up`. */
export const postingCatchUpSchema = z.object({
  dryRun: z.boolean(),
  invoices: z.number().int(),
  creditNotesCorrected: z.number().int(),
  bills: z.number().int(),
  payments: z.number().int(),
  bankTransactions: z.number().int(),
  taxLines: z.number().int(),
  skipped: z.array(
    z.object({ type: z.string(), id: z.string(), number: z.string().nullable(), reason: z.string() }),
  ),
});

// ── accounting entities ─────────────────────────────────────────────────────

/** An `entities` row as the API answers it: secrets out, flags in. */
export const accountingEntitySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    jurisdictionCode: z.string(),
    baseCurrency: z.string(),
    hasSsn: z.boolean(),
    hasSalesTaxCredentials: z.boolean(),
    hasFiscalCredentials: z.boolean(),
  })
  .passthrough();

/** `POST /api/accounting-entities`: the entity and what was seeded. */
export const accountingEntityCreatedSchema = accountingEntitySchema.extend({
  accountsCreated: z.number().int(),
  taxRatesCreated: z.number().int(),
});

/** `GET /api/accounting-entities/:id`: the entity and what is frozen. */
export const accountingEntityDetailSchema = accountingEntitySchema.extend({
  hasPostings: z.boolean(),
  hasFiscalPeriods: z.boolean(),
  baseSettingsLocked: z.boolean(),
  fiscalYearLocked: z.boolean(),
});

/** One supported jurisdiction (`GET /api/accounting-entities/jurisdictions`). */
export const jurisdictionSummarySchema = z
  .object({
    code: z.string(),
    name: z.string(),
    defaultLocale: z.string(),
    defaultCurrency: z.string(),
    features: z.record(z.boolean()),
    terminology: z.record(z.unknown()),
    invoiceRequiredFields: z.array(z.string()),
  })
  .passthrough();

/** A `lock_date_exceptions` row. */
export const lockDateExceptionSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    lockType: z.string(),
    userId: nullableString,
    endsAt: z.string(),
    reason: z.string(),
    createdBy: nullableString,
    revokedAt: nullableString,
    revokedBy: nullableString,
    createdAt: z.string(),
  })
  .passthrough();
