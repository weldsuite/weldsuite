import {
  pgTable,
  varchar,
  timestamp,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

/**
 * How a payment is spread over invoices or bills: one check can pay five
 * bills, one customer transfer can settle several invoices.
 *
 * `amount` is in the payment's currency. The part of a payment not allocated
 * to any document stays on the counterparty's receivable/payable account as
 * an unapplied credit.
 */
export const paymentAllocations = pgTable('payment_allocations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  paymentId: varchar('payment_id', { length: 30 }).notNull(),
  invoiceId: varchar('invoice_id', { length: 30 }),
  billId: varchar('bill_id', { length: 30 }),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
}, (table) => [
  index('acct_payment_allocations_payment_idx').on(table.paymentId),
  index('acct_payment_allocations_invoice_idx').on(table.invoiceId),
  index('acct_payment_allocations_bill_idx').on(table.billId),
]);

export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type NewPaymentAllocation = typeof paymentAllocations.$inferInsert;
