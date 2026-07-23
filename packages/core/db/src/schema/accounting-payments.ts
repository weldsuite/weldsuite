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
  paymentMethod: varchar('payment_method', { length: 20 }),
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
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
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
