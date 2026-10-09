import {
  pgTable,
  varchar,
  timestamp,
  date,
  integer,
  boolean,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const bankAccounts = pgTable('bank_accounts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  iban: varchar('iban', { length: 34 }),
  bic: varchar('bic', { length: 11 }),
  bankName: varchar('bank_name', { length: 255 }),
  accountHolderName: varchar('account_holder_name', { length: 255 }),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  ledgerAccountId: varchar('ledger_account_id', { length: 30 }),
  currentBalance: numeric('current_balance', { precision: 18, scale: 2 }).default('0'),
  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),
  lastImportDate: timestamp('last_import_date'),
  lastImportBalance: numeric('last_import_balance', { precision: 18, scale: 2 }),
  autoReconcile: boolean('auto_reconcile').default(true),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  /** checking | savings | credit_card | money_market | line_of_credit. Cards and lines of credit sit on a liability account. */
  accountType: varchar('account_type', { length: 20 }),
  /** US ABA routing number (checksum-validated). */
  routingNumber: varchar('routing_number', { length: 9 }),
  /** AES-GCM blob of the full account number; only the last four are shown. */
  accountNumberEncrypted: text('account_number_encrypted'),
  accountNumberLast4: varchar('account_number_last4', { length: 4 }),

  /** Bank feed link (`bank_connections`) and the provider's account id. */
  feedConnectionId: varchar('feed_connection_id', { length: 30 }),
  feedProvider: varchar('feed_provider', { length: 30 }),
  feedAccountId: varchar('feed_account_id', { length: 255 }),
  /** Institution + mask + subtype, so a relink or provider switch reattaches here. */
  feedAccountFingerprint: varchar('feed_account_fingerprint', { length: 255 }),
  /** Feed transactions before this date are skipped (the file import covers them). */
  feedSyncFrom: date('feed_sync_from'),
  /** Per-account feed status (Stripe FC tracks status per account). */
  feedStatus: varchar('feed_status', { length: 20 }),

  /** Checks: next check number, layout and MICR settings. */
  nextCheckNumber: integer('next_check_number'),
  checkSettings: jsonb('check_settings').$type<Record<string, unknown>>(),
  /** NACHA origination settings (immediate origin/destination, company id, balanced file). */
  achSettings: jsonb('ach_settings').$type<Record<string, unknown>>(),
  /** Positive Pay file format of the bank (generic_csv, bofa, chase, wells_fargo, ...). */
  positivePayFormat: varchar('positive_pay_format', { length: 30 }),
  /** Remembered CSV import format (date order, thousands separator, sign style, columns). */
  importSettings: jsonb('import_settings').$type<Record<string, unknown>>(),
}, (table) => [
  index('acct_bank_accounts_feed_connection_idx').on(table.feedConnectionId),
  index('acct_bank_accounts_entity_idx').on(table.entityId),
  index('acct_bank_accounts_iban_idx').on(table.iban),
  index('acct_bank_accounts_is_active_idx').on(table.isActive),
]);

export type BankAccount = typeof bankAccounts.$inferSelect;
export type NewBankAccount = typeof bankAccounts.$inferInsert;
