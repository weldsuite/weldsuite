/**
 * Response shapes of books-api's banking area (WeldBooks): bank accounts,
 * bank transactions and statement import, reconciliation rules, deposits,
 * statement reconciliations and bank-feed connections.
 *
 * The platform reads these through TypeScript interfaces
 * (`apps/web/platform/lib/api/domains/weldbooks-banking.ts`,
 * `weldbooks-bank-feeds.ts`, `weldbooks.ts`); these Zod schemas mirror them so
 * the Rust backend's answers are checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-books-banking.ts`).
 * Rows are `.passthrough()`: the routes answer whole table rows (or the object
 * they wrote), and the schemas pin the fields the clients read. Drizzle reads
 * `numeric` columns as strings and `timestamp` columns as ISO strings; `date`
 * columns are `YYYY-MM-DD`.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const nullishString = z.string().nullish();

// ── bank accounts ───────────────────────────────────────────────────────────

/**
 * A bank account as the routes answer it (`publicBankAccount`): the row, or
 * on create the object written, without the encrypted account number.
 */
export const bankAccountSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    name: z.string(),
    currency: nullishString,
    ledgerAccountId: nullishString,
    accountType: nullishString,
    accountNumberLast4: nullishString,
    routingNumber: nullishString,
    iban: nullishString,
    currentBalance: nullishString,
    isActive: z.boolean().optional(),
    isDefault: z.boolean().nullish(),
    importSettings: z.record(z.unknown()).nullish(),
    hasAccountNumber: z.boolean(),
  })
  .passthrough()
  .refine((row) => !('accountNumberEncrypted' in row), { message: 'the encrypted number must not leave the worker' });

/** `POST /api/bank-accounts`: the account and the ledger account it sits on (when one was picked or made). */
export const createdBankAccountSchema = z
  .object({
    id: z.string(),
    hasAccountNumber: z.boolean(),
    ledgerAccount: z
      .object({ id: z.string(), code: z.string(), name: z.string(), created: z.boolean() })
      .optional(),
  })
  .passthrough();

/** `POST /api/bank-accounts/:id/reveal-account-number`. */
export const revealedAccountNumberSchema = z.object({
  accountNumber: z.string(),
  routingNumber: nullableString,
  accountNumberLast4: nullableString,
});

// ── reconciliation rules ────────────────────────────────────────────────────

const ruleConditionSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.union([z.string(), z.number()]),
  value2: z.number().optional(),
});

/** A `reconciliation_rules` row, or the rule a create or update answers. */
export const reconciliationRuleSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    name: z.string(),
    priority: z.number().nullish(),
    matchMode: nullishString,
    conditions: z.array(ruleConditionSchema).nullish(),
    actions: z.record(z.unknown()).nullish(),
    isActive: z.boolean().nullish(),
    matchCount: z.number().nullish(),
  })
  .passthrough();

// ── bank transactions ───────────────────────────────────────────────────────

/** A `bank_transactions` row. */
export const bankTransactionSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    bankAccountId: z.string(),
    date: z.string(),
    amount: z.string(),
    status: z.string(),
    description: nullishString,
    counterpartyName: nullishString,
    reference: nullishString,
    source: nullishString,
    journalEntryId: nullishString,
  })
  .passthrough();

/** `POST /api/bank-transactions`: the line written, its status and the entry it posted (if any). */
export const createdBankTransactionSchema = bankTransactionSchema.extend({
  journalEntryId: nullableString,
  categoryAccountId: nullableString,
});

const parseIssueSchema = z.object({ line: z.number().optional(), message: z.string() });
const csvProposalSchema = z
  .object({
    format: z.record(z.unknown()),
    headers: z.array(z.string()),
    sampleRows: z.array(z.array(z.string())),
    dateOrderAmbiguous: z.boolean(),
    warnings: z.array(z.string()),
  })
  .passthrough();

/** `POST /api/bank-transactions/import/preview`. */
export const importPreviewSchema = z
  .object({
    format: z.string(),
    needsCsvFormat: z.boolean(),
    proposal: csvProposalSchema.optional(),
    totalParsed: z.number().optional(),
    duplicates: z.number().nullable().optional(),
    errors: z.array(parseIssueSchema).optional(),
    sample: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

/** `POST /api/bank-transactions/import`. */
export const importResultSchema = z.object({
  batchId: z.string(),
  format: z.string(),
  totalParsed: z.number(),
  imported: z.number(),
  duplicates: z.number(),
  autoReconciled: z.number(),
  errors: z.array(parseIssueSchema),
  dateRange: z.object({ from: z.string(), to: z.string() }).nullable(),
  closingBalance: z.number().nullable(),
  currency: nullableString,
  csvFormatRemembered: z.boolean(),
  warning: z.object({ code: z.string(), message: z.string() }).nullable(),
});

/** `POST /api/bank-transactions/auto-reconcile`. */
export const autoReconcileResultSchema = z.object({
  reconciledCount: z.number(),
  results: z.array(
    z
      .object({ transactionId: z.string(), suggestions: z.array(z.record(z.unknown())), autoReconciled: z.boolean() })
      .passthrough(),
  ),
});

/** `GET /api/bank-transactions/:id/suggestions`: one match. */
export const matchSuggestionSchema = z.object({
  type: z.enum(['invoice', 'bill', 'payment', 'deposit']),
  id: z.string(),
  number: nullableString,
  contactName: nullableString,
  amount: z.string(),
  confidence: z.number(),
  reasons: z.array(z.string()),
});

/** What the matching routes answer: the line's id and new status, and what it was tied to. */
export const bankLineMatchSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    journalEntryId: nullableString.optional(),
    paymentId: z.string().optional(),
    depositId: z.string().optional(),
  })
  .passthrough();

/** `POST /api/bank-transactions/:id/exclude`. */
export const bankLineExcludedSchema = z.object({ message: z.string() });

// ── bank deposits ───────────────────────────────────────────────────────────

/** `GET /api/bank-deposits/undeposited`: a received payment waiting in Undeposited Funds. */
export const undepositedPaymentSchema = z.object({
  paymentId: z.string(),
  date: z.string(),
  paymentMethod: nullableString,
  checkNumber: nullableString,
  reference: nullableString,
  currency: nullableString,
  paymentAmount: z.string(),
  amount: z.number(),
  contactId: z.string(),
  contactName: nullableString,
  journalEntryId: nullableString,
});

/** A `bank_deposits` row. */
export const bankDepositSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    bankAccountId: z.string(),
    date: z.string(),
    amount: z.string(),
    currency: z.string(),
    status: z.string(),
    memo: nullishString,
  })
  .passthrough();

/** `GET /api/bank-deposits/:id`: the deposit with its payments and other lines. */
export const bankDepositDetailSchema = bankDepositSchema.extend({
  bankAccountName: nullableString,
  journalEntryNumber: nullableString,
  payments: z.array(z.object({ id: z.string(), amount: z.string(), contactName: nullableString }).passthrough()),
  otherLines: z.array(
    z.object({ accountId: z.string(), amount: z.number(), accountCode: nullableString, accountName: nullableString }).passthrough(),
  ),
});

/** `POST /api/bank-deposits`. */
export const createdBankDepositSchema = z.object({ id: z.string(), journalEntryId: nullableString, amount: z.string() });

// ── statement reconciliations ───────────────────────────────────────────────

const reconciliationLineSchema = z
  .object({
    id: z.string(),
    journalEntryId: z.string(),
    date: z.string(),
    amount: z.number(),
    cleared: z.boolean(),
    document: z.object({ type: z.string(), id: nullableString }).passthrough().nullable(),
  })
  .passthrough();
const lineGroupTotalsSchema = z.object({ count: z.number(), total: z.number(), clearedCount: z.number(), clearedTotal: z.number() });

/** A reconciliation as the screen reads it (`getReconciliationView`). */
export const reconciliationViewSchema = z
  .object({
    id: z.string(),
    bankAccountId: z.string(),
    bankAccountName: nullableString,
    ledgerAccountId: z.string(),
    ledger: z.object({ code: z.string(), name: z.string(), type: z.string() }),
    accountKind: z.enum(['bank', 'credit_card']),
    status: z.string(),
    statementDate: z.string(),
    beginningBalance: z.string(),
    statementEndingBalance: z.string(),
    clearedBalance: z.string(),
    difference: z.string(),
    clearedLineIds: z.array(z.string()),
    inflows: z.array(reconciliationLineSchema),
    outflows: z.array(reconciliationLineSchema),
    totals: z.object({ inflows: lineGroupTotalsSchema, outflows: lineGroupTotalsSchema }),
    nettedLineCount: z.number(),
  })
  .passthrough();

/** `GET /api/bank-reconciliations`: a history row, without its report. */
export const reconciliationHistorySchema = z
  .object({ id: z.string(), bankAccountId: z.string(), statementDate: z.string(), status: z.string(), hasReport: z.boolean() })
  .passthrough()
  .refine((row) => !('report' in row), { message: 'the history does not carry the report' });

/** `GET /api/bank-reconciliations/:id/report`: the stored report, or a live preview. */
export const reconciliationReportSchema = z
  .object({ status: z.string(), version: z.number(), summary: z.record(z.unknown()), preview: z.boolean().optional() })
  .passthrough();
