import {
  pgTable,
  varchar,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const bankImportBatches = pgTable('bank_import_batches', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  bankAccountId: varchar('bank_account_id', { length: 30 }).notNull(),
  fileName: varchar('file_name', { length: 255 }),
  fileKey: varchar('file_key', { length: 500 }),
  format: varchar('format', { length: 10 }),
  totalTransactions: integer('total_transactions'),
  importedCount: integer('imported_count'),
  duplicateCount: integer('duplicate_count'),
  autoReconciledCount: integer('auto_reconciled_count'),
  status: varchar('status', { length: 15 }).default('processing').notNull(),
  dateRange: jsonb('date_range').$type<{ from?: string; to?: string }>(),
  openingBalance: numeric('opening_balance', { precision: 18, scale: 2 }),
  closingBalance: numeric('closing_balance', { precision: 18, scale: 2 }),
  errors: jsonb('errors').$type<Array<{ line?: number; message: string }>>(),
  importedBy: varchar('imported_by', { length: 255 }),
}, (table) => [
  index('acct_bank_import_entity_idx').on(table.entityId),
  index('acct_bank_import_bank_account_idx').on(table.bankAccountId),
  index('acct_bank_import_status_idx').on(table.status),
]);

export type BankImportBatch = typeof bankImportBatches.$inferSelect;
export type NewBankImportBatch = typeof bankImportBatches.$inferInsert;
