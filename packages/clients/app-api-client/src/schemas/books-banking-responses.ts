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
