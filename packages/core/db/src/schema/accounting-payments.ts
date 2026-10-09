import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  numeric,
  text,
  index,
} from 'drizzle-orm/pg-core';

export const payments = pgTable('payments', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  type: varchar('type', { length: 10 }).notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  exchangeRate: numeric('exchange_rate', { precision: 12, scale: 6 }).default('1'),
  date: timestamp('date').notNull(),
  /**
   * check | ach | wire | credit_card | debit_card | cash | third_party_network |
   * bank_transfer | direct_debit | ideal | other (validated by books-api).
   */
  paymentMethod: varchar('payment_method', { length: 20 }),
  checkNumber: varchar('check_number', { length: 30 }),
  reference: varchar('reference', { length: 255 }),

  invoiceId: varchar('invoice_id', { length: 30 }),
  billId: varchar('bill_id', { length: 30 }),
  contactId: varchar('contact_id', { length: 30 }).notNull(),
  // Counterparty + person (new — populated by migration backfill).
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),
  bankAccountId: varchar('bank_account_id', { length: 30 }),
  bankTransactionId: varchar('bank_transaction_id', { length: 30 }),
  journalEntryId: varchar('journal_entry_id', { length: 30 }),
  exchangeDifferenceEntryId: varchar('exchange_difference_entry_id', { length: 30 }),

  notes: text('notes'),
  isPartial: boolean('is_partial').default(false),
  /** Received into Undeposited Funds and later grouped into this bank deposit. */
  depositId: varchar('deposit_id', { length: 30 }),
  /** The check or ACH run that made this payment. */
  paymentRunId: varchar('payment_run_id', { length: 30 }),
  /** Checks: to_print | printed | voided | cleared. */
  checkStatus: varchar('check_status', { length: 10 }),
  checkPrintedAt: timestamp('check_printed_at'),
  /** US backup withholding (24%) kept back from a vendor without a valid TIN. */
  backupWithholdingAmount: numeric('backup_withholding_amount', { precision: 18, scale: 2 }),
  /** Paid through a payroll provider, which files the 1099 itself. */
  paidThroughPayroll: boolean('paid_through_payroll').default(false),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_payments_deposit_idx').on(table.depositId),
  index('acct_payments_run_idx').on(table.paymentRunId),
  index('acct_payments_entity_idx').on(table.entityId),
  index('acct_payments_type_idx').on(table.type),
  index('acct_payments_invoice_idx').on(table.invoiceId),
  index('acct_payments_bill_idx').on(table.billId),
  index('acct_payments_contact_idx').on(table.contactId),
  index('acct_payments_counterparty_idx').on(table.counterpartyId),
  index('acct_payments_person_idx').on(table.personId),
  index('acct_payments_bank_txn_idx').on(table.bankTransactionId),
  index('acct_payments_date_idx').on(table.date),
]);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
