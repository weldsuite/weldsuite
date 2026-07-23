import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const journalEntries = pgTable('journal_entries', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  entryNumber: varchar('entry_number', { length: 50 }),
  date: timestamp('date').notNull(),
  status: varchar('status', { length: 10 }).default('draft').notNull(),
  description: text('description'),
  reference: varchar('reference', { length: 255 }),

  totalDebit: numeric('total_debit', { precision: 18, scale: 2 }).default('0'),
  totalCredit: numeric('total_credit', { precision: 18, scale: 2 }).default('0'),

  sourceType: varchar('source_type', { length: 30 }),
  sourceId: varchar('source_id', { length: 30 }),
  reversalOfId: varchar('reversal_of_id', { length: 30 }),
  reversedById: varchar('reversed_by_id', { length: 30 }),
  fiscalPeriodId: varchar('fiscal_period_id', { length: 30 }),

  attachmentKeys: jsonb('attachment_keys').$type<string[]>(),
  isAutomatic: boolean('is_automatic').default(false),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_journal_entries_entity_idx').on(table.entityId),
  index('acct_journal_entries_number_idx').on(table.entryNumber),
  index('acct_journal_entries_date_idx').on(table.date),
  index('acct_journal_entries_status_idx').on(table.status),
  index('acct_journal_entries_source_type_idx').on(table.sourceType),
  index('acct_journal_entries_source_id_idx').on(table.sourceId),
  index('acct_journal_entries_fiscal_period_idx').on(table.fiscalPeriodId),
]);

export const journalLines = pgTable('journal_lines', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  journalEntryId: varchar('journal_entry_id', { length: 30 }).notNull(),
  accountId: varchar('account_id', { length: 30 }).notNull(),
  description: text('description'),
  debit: numeric('debit', { precision: 18, scale: 2 }).default('0'),
  credit: numeric('credit', { precision: 18, scale: 2 }).default('0'),
  taxRateId: varchar('tax_rate_id', { length: 30 }),
  taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }),
  contactId: varchar('contact_id', { length: 30 }),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  exchangeRate: numeric('exchange_rate', { precision: 12, scale: 6 }).default('1'),
  baseCurrencyDebit: numeric('base_currency_debit', { precision: 18, scale: 2 }),
  baseCurrencyCredit: numeric('base_currency_credit', { precision: 18, scale: 2 }),
  reconciled: boolean('reconciled').default(false),
  sortOrder: integer('sort_order'),
}, (table) => [
  index('acct_journal_lines_entity_idx').on(table.entityId),
  index('acct_journal_lines_entry_idx').on(table.journalEntryId),
  index('acct_journal_lines_account_idx').on(table.accountId),
  index('acct_journal_lines_contact_idx').on(table.contactId),
]);

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
