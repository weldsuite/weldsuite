import {
  pgTable,
  varchar,
  timestamp,
  numeric,
  text,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const bankTransactions = pgTable('bank_transactions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  bankAccountId: varchar('bank_account_id', { length: 30 }).notNull(),
  date: timestamp('date').notNull(),
  valueDate: timestamp('value_date'),
  description: text('description'),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  runningBalance: numeric('running_balance', { precision: 18, scale: 2 }),
  counterpartyName: varchar('counterparty_name', { length: 255 }),
  counterpartyIban: varchar('counterparty_iban', { length: 34 }),
  counterpartyBic: varchar('counterparty_bic', { length: 11 }),
  reference: varchar('reference', { length: 255 }),
  transactionCode: varchar('transaction_code', { length: 20 }),
  endToEndId: varchar('end_to_end_id', { length: 255 }),
  mandateId: varchar('mandate_id', { length: 255 }),
  importBatchId: varchar('import_batch_id', { length: 30 }),
  externalId: varchar('external_id', { length: 255 }),

  status: varchar('status', { length: 15 }).default('unreconciled').notNull(),
  reconciliationType: varchar('reconciliation_type', { length: 15 }),
  reconciledInvoiceId: varchar('reconciled_invoice_id', { length: 30 }),
  reconciledBillId: varchar('reconciled_bill_id', { length: 30 }),
  reconciledPaymentId: varchar('reconciled_payment_id', { length: 30 }),
  journalEntryId: varchar('journal_entry_id', { length: 30 }),
  categoryAccountId: varchar('category_account_id', { length: 30 }),
  taxRateId: varchar('tax_rate_id', { length: 30 }),
  contactId: varchar('contact_id', { length: 30 }),
  notes: text('notes'),
  rawData: jsonb('raw_data').$type<Record<string, unknown>>(),

  /** import | feed | manual */
  source: varchar('source', { length: 10 }),
  feedProvider: varchar('feed_provider', { length: 30 }),
  /** The aggregator's transaction id; unique per bank account and provider. */
  providerTransactionId: varchar('provider_transaction_id', { length: 255 }),
  checkNumber: varchar('check_number', { length: 30 }),
  merchantName: varchar('merchant_name', { length: 255 }),
  feedCategory: jsonb('feed_category').$type<Record<string, unknown>>(),
  /** Date + amount + normalized description, to flag likely duplicates after a relink or provider switch. */
  fingerprint: varchar('fingerprint', { length: 64 }),
  possibleDuplicateOfId: varchar('possible_duplicate_of_id', { length: 30 }),
  /** Matched to a bank deposit (several received payments in one line). */
  depositId: varchar('deposit_id', { length: 30 }),
}, (table) => [
  uniqueIndex('acct_bank_txn_provider_uidx')
    .on(table.bankAccountId, table.feedProvider, table.providerTransactionId)
    .where(sql`${table.providerTransactionId} is not null`),
  index('acct_bank_txn_fingerprint_idx').on(table.fingerprint),
  index('acct_bank_txn_entity_idx').on(table.entityId),
  index('acct_bank_txn_bank_account_idx').on(table.bankAccountId),
  index('acct_bank_txn_date_idx').on(table.date),
  index('acct_bank_txn_status_idx').on(table.status),
  index('acct_bank_txn_external_id_idx').on(table.externalId),
  index('acct_bank_txn_counterparty_iban_idx').on(table.counterpartyIban),
  index('acct_bank_txn_import_batch_idx').on(table.importBatchId),
  index('acct_bank_txn_reconciled_invoice_idx').on(table.reconciledInvoiceId),
  index('acct_bank_txn_reconciled_bill_idx').on(table.reconciledBillId),
]);

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;
