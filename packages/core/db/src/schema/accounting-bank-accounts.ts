import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  numeric,
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
}, (table) => [
  index('acct_bank_accounts_entity_idx').on(table.entityId),
  index('acct_bank_accounts_iban_idx').on(table.iban),
  index('acct_bank_accounts_is_active_idx').on(table.isActive),
]);

export type BankAccount = typeof bankAccounts.$inferSelect;
export type NewBankAccount = typeof bankAccounts.$inferInsert;
