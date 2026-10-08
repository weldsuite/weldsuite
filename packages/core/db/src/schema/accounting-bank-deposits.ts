import {
  pgTable,
  varchar,
  timestamp,
  date,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * A bank deposit: received payments parked in Undeposited Funds, grouped into
 * the single deposit line the bank shows. Posting debits the bank account and
 * credits Undeposited Funds (plus any other lines, e.g. cash back).
 */
export const bankDeposits = pgTable('bank_deposits', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  bankAccountId: varchar('bank_account_id', { length: 30 }).notNull(),
  date: date('date').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  memo: text('memo'),
  /** Extra lines on the deposit slip: positive adds to the deposit, negative is cash back. */
  otherLines: jsonb('other_lines').$type<Array<{ accountId: string; amount: number; description?: string }>>(),
  /** posted | void */
  status: varchar('status', { length: 10 }).notNull().default('posted'),
  journalEntryId: varchar('journal_entry_id', { length: 30 }),
  /** The bank line this deposit was matched to. */
  bankTransactionId: varchar('bank_transaction_id', { length: 30 }),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_bank_deposits_entity_idx').on(table.entityId),
  index('acct_bank_deposits_bank_account_idx').on(table.bankAccountId),
  index('acct_bank_deposits_date_idx').on(table.date),
]);

/**
 * A statement reconciliation: the bookkeeper enters the statement's ending
 * date and balance, ticks the ledger lines that cleared, and finishes when the
 * difference is zero. Completing stamps `journal_lines.reconciliation_id`;
 * an admin can undo the latest one.
 */
export const bankReconciliations = pgTable('bank_reconciliations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  bankAccountId: varchar('bank_account_id', { length: 30 }).notNull(),
  ledgerAccountId: varchar('ledger_account_id', { length: 30 }).notNull(),
  statementDate: date('statement_date').notNull(),
  beginningBalance: numeric('beginning_balance', { precision: 18, scale: 2 }).notNull(),
  statementEndingBalance: numeric('statement_ending_balance', { precision: 18, scale: 2 }).notNull(),
  clearedBalance: numeric('cleared_balance', { precision: 18, scale: 2 }),
  difference: numeric('difference', { precision: 18, scale: 2 }),
  /** in_progress | completed | undone */
  status: varchar('status', { length: 15 }).notNull().default('in_progress'),
  /** Ticked journal line ids while in progress. */
  clearedLineIds: jsonb('cleared_line_ids').$type<string[]>(),
  /** Report snapshot taken when the reconciliation completes. */
  report: jsonb('report').$type<Record<string, unknown>>(),
  adjustmentJournalEntryId: varchar('adjustment_journal_entry_id', { length: 30 }),
  completedAt: timestamp('completed_at'),
  completedBy: varchar('completed_by', { length: 255 }),
  undoneAt: timestamp('undone_at'),
  undoneBy: varchar('undone_by', { length: 255 }),
}, (table) => [
  index('acct_bank_recs_entity_idx').on(table.entityId),
  index('acct_bank_recs_bank_account_idx').on(table.bankAccountId, table.statementDate),
]);

export type BankDeposit = typeof bankDeposits.$inferSelect;
export type NewBankDeposit = typeof bankDeposits.$inferInsert;
export type BankReconciliation = typeof bankReconciliations.$inferSelect;
export type NewBankReconciliation = typeof bankReconciliations.$inferInsert;
