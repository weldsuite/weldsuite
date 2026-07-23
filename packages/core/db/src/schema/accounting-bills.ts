import {
  pgTable,
  varchar,
  timestamp,
  integer,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const bills = pgTable('bills', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  billNumber: varchar('bill_number', { length: 50 }),
  type: varchar('type', { length: 15 }).default('standard').notNull(),
  status: varchar('status', { length: 20 }).default('draft').notNull(),
  contactId: varchar('contact_id', { length: 30 }).notNull(),
  contactName: varchar('contact_name', { length: 255 }),
  // Counterparty + person (new — populated by migration backfill).
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),

  issueDate: timestamp('issue_date').notNull(),
  dueDate: timestamp('due_date').notNull(),
  paidAt: timestamp('paid_at'),

  currency: varchar('currency', { length: 3 }).default('EUR'),
  exchangeRate: numeric('exchange_rate', { precision: 12, scale: 6 }).default('1'),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).default('0'),
  discountTotal: numeric('discount_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: numeric('tax_total', { precision: 18, scale: 2 }).default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).default('0'),
  amountPaid: numeric('amount_paid', { precision: 18, scale: 2 }).default('0'),
  balanceDue: numeric('balance_due', { precision: 18, scale: 2 }).default('0'),

  paymentTermsDays: integer('payment_terms_days'),
  externalReference: varchar('external_reference', { length: 255 }),
  reference: varchar('reference', { length: 255 }),
  notes: text('notes'),
  internalNotes: text('internal_notes'),

  expenseAccountId: varchar('expense_account_id', { length: 30 }),
  sourceDocumentId: varchar('source_document_id', { length: 30 }),

  approvalStatus: varchar('approval_status', { length: 15 }).default('pending'),
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),
  rejectedBy: varchar('rejected_by', { length: 255 }),
  rejectedAt: timestamp('rejected_at'),
  rejectionReason: text('rejection_reason'),

  attachmentKeys: jsonb('attachment_keys').$type<string[]>(),
  taxBreakdown: jsonb('tax_breakdown').$type<Array<{
    taxRateId: string;
    taxRateName: string;
    taxRate: number;
    taxableAmount: number;
    taxAmount: number;
  }>>(),

  journalEntryId: varchar('journal_entry_id', { length: 30 }),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_bills_entity_idx').on(table.entityId),
  index('acct_bills_number_idx').on(table.billNumber),
  index('acct_bills_contact_idx').on(table.contactId),
  index('acct_bills_counterparty_idx').on(table.counterpartyId),
  index('acct_bills_person_idx').on(table.personId),
  index('acct_bills_status_idx').on(table.status),
  index('acct_bills_issue_date_idx').on(table.issueDate),
  index('acct_bills_due_date_idx').on(table.dueDate),
  index('acct_bills_type_idx').on(table.type),
]);

export const billItems = pgTable('bill_items', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  billId: varchar('bill_id', { length: 30 }).notNull(),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 10, scale: 4 }).default('1'),
  unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
  unit: varchar('unit', { length: 20 }),
  discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).default('0'),
  taxRateId: varchar('tax_rate_id', { length: 30 }),
  taxRate: numeric('tax_rate', { precision: 5, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }),
  lineTotal: numeric('line_total', { precision: 18, scale: 2 }),
  lineTotalWithTax: numeric('line_total_with_tax', { precision: 18, scale: 2 }),
  accountId: varchar('account_id', { length: 30 }),
  productId: varchar('product_id', { length: 30 }),
  period: jsonb('period').$type<{ from?: string; to?: string }>(),
  sortOrder: integer('sort_order').default(0),
}, (table) => [
  index('acct_bill_items_entity_idx').on(table.entityId),
  index('acct_bill_items_bill_idx').on(table.billId),
]);

export type Bill = typeof bills.$inferSelect;
export type NewBill = typeof bills.$inferInsert;
export type BillItem = typeof billItems.$inferSelect;
export type NewBillItem = typeof billItems.$inferInsert;
