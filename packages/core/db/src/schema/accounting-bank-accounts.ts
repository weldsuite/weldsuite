/**
 * WeldBooks' extension of a core bank account (docs/plans/legal-entities.md).
 *
 * The account itself (`bank_accounts`: holder, IBAN, routing and account
 * number, NACHA settings) is core and lives in ./legal-entities.ts. A row
 * here means the account is in WeldBooks: its ledger account, balances, bank
 * feed link, check printing and import settings. Release 1 writes these
 * columns here and on `bank_accounts` (mirror) and still reads them from
 * `bank_accounts`; release 2 switches the reads and drops the old columns.
 */

import {
  pgTable,
  varchar,
  timestamp,
  date,
  integer,
  boolean,
  numeric,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const accountingBankAccountSettings = pgTable('accounting_bank_account_settings', {
  /** `bank_accounts.id`. */
  bankAccountId: varchar('bank_account_id', { length: 30 }).primaryKey(),
  /** `entities.id`, the account's entity (denormalised for per-entity lookups). */
  entityId: varchar('entity_id', { length: 30 }).notNull(),

  ledgerAccountId: varchar('ledger_account_id', { length: 30 }),
  currentBalance: numeric('current_balance', { precision: 18, scale: 2 }).default('0'),
  lastImportDate: timestamp('last_import_date'),
  lastImportBalance: numeric('last_import_balance', { precision: 18, scale: 2 }),
  autoReconcile: boolean('auto_reconcile').default(true),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  feedConnectionId: varchar('feed_connection_id', { length: 30 }),
  feedProvider: varchar('feed_provider', { length: 30 }),
  feedAccountId: varchar('feed_account_id', { length: 255 }),
  feedAccountFingerprint: varchar('feed_account_fingerprint', { length: 255 }),
  feedSyncFrom: date('feed_sync_from'),
  feedStatus: varchar('feed_status', { length: 20 }),

  nextCheckNumber: integer('next_check_number'),
  checkSettings: jsonb('check_settings').$type<Record<string, unknown>>(),
  positivePayFormat: varchar('positive_pay_format', { length: 30 }),
  importSettings: jsonb('import_settings').$type<Record<string, unknown>>(),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('acct_bank_account_settings_entity_idx').on(table.entityId),
]);

export type AccountingBankAccountSettings = typeof accountingBankAccountSettings.$inferSelect;
export type NewAccountingBankAccountSettings = typeof accountingBankAccountSettings.$inferInsert;
