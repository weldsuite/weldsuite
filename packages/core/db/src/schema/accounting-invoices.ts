import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import type { StoredPostalAddress } from './accounting-address';
import type { DocumentTaxBreakdownRow } from './accounting-tax-lines';

export const invoices = pgTable('invoices', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  invoiceNumber: varchar('invoice_number', { length: 50 }),
  type: varchar('type', { length: 15 }).default('standard').notNull(),
  status: varchar('status', { length: 15 }).default('draft').notNull(),
  contactId: varchar('contact_id', { length: 30 }).notNull(),
  contactName: varchar('contact_name', { length: 255 }),
  contactEmail: varchar('contact_email', { length: 255 }),
  // Counterparty + person (new — populated by migration backfill).
  // counterpartyId is the party being invoiced; personId optionally
  // identifies the specific human at a Company.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),

  issueDate: timestamp('issue_date').notNull(),
  dueDate: timestamp('due_date').notNull(),
  paidAt: timestamp('paid_at'),
  sentAt: timestamp('sent_at'),
  viewedAt: timestamp('viewed_at'),

  currency: varchar('currency', { length: 3 }).default('EUR'),
  exchangeRate: numeric('exchange_rate', { precision: 12, scale: 6 }).default('1'),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).default('0'),
  discountTotal: numeric('discount_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: numeric('tax_total', { precision: 18, scale: 2 }).default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).default('0'),
  amountPaid: numeric('amount_paid', { precision: 18, scale: 2 }).default('0'),
  balanceDue: numeric('balance_due', { precision: 18, scale: 2 }).default('0'),

  paymentTermsDays: integer('payment_terms_days'),
  reference: varchar('reference', { length: 255 }),
  notes: text('notes'),
  internalNotes: text('internal_notes'),
  billingAddress: jsonb('billing_address').$type<StoredPostalAddress>(),
  /** Where the goods or service go; drives destination-based tax. Falls back to the billing address. */
  shippingAddress: jsonb('shipping_address').$type<StoredPostalAddress>(),

  revenueAccountId: varchar('revenue_account_id', { length: 30 }),
  creditNoteForInvoiceId: varchar('credit_note_for_invoice_id', { length: 30 }),
  originalInvoiceId: varchar('original_invoice_id', { length: 30 }),
  recurringInvoiceId: varchar('recurring_invoice_id', { length: 30 }),
  commerceOrderId: varchar('commerce_order_id', { length: 30 }),

  attachmentKeys: jsonb('attachment_keys').$type<string[]>(),
  emailHistory: jsonb('email_history').$type<Array<{
    sentAt: string;
    to: string;
    subject: string;
    status: string;
  }>>(),
  taxBreakdown: jsonb('tax_breakdown').$type<DocumentTaxBreakdownRow[]>(),

  /** Origin for origin-sourced US sales tax; defaults to the entity address. */
  shipFromAddress: jsonb('ship_from_address').$type<StoredPostalAddress>(),
  /** Sales tax engine that produced taxBreakdown (manual, stripe_tax, avalara), its reference and warnings. */
  taxEngine: varchar('tax_engine', { length: 30 }),
  taxEngineRef: varchar('tax_engine_ref', { length: 255 }),
  taxCalculatedAt: timestamp('tax_calculated_at'),
  /** When the finalized document was recorded with the provider engine. */
  taxCommittedAt: timestamp('tax_committed_at'),
  taxWarnings: jsonb('tax_warnings').$type<string[]>(),
  /** Sold through a marketplace facilitator that collects the tax: counts toward nexus, no tax charged. */
  marketplaceFacilitated: boolean('marketplace_facilitated').default(false),

  paymentLink: varchar('payment_link', { length: 500 }),
  journalEntryId: varchar('journal_entry_id', { length: 30 }),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_invoices_entity_idx').on(table.entityId),
  index('acct_invoices_number_idx').on(table.invoiceNumber),
  index('acct_invoices_contact_idx').on(table.contactId),
  index('acct_invoices_counterparty_idx').on(table.counterpartyId),
  index('acct_invoices_person_idx').on(table.personId),
  index('acct_invoices_status_idx').on(table.status),
  index('acct_invoices_issue_date_idx').on(table.issueDate),
  index('acct_invoices_due_date_idx').on(table.dueDate),
  index('acct_invoices_type_idx').on(table.type),
]);

export const invoiceItems = pgTable('invoice_items', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  invoiceId: varchar('invoice_id', { length: 30 }).notNull(),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 10, scale: 4 }).default('1'),
  unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
  unit: varchar('unit', { length: 20 }),
  discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).default('0'),
  taxRateId: varchar('tax_rate_id', { length: 30 }),
  taxRate: numeric('tax_rate', { precision: 7, scale: 4 }),
  taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }),
  lineTotal: numeric('line_total', { precision: 18, scale: 2 }),
  lineTotalWithTax: numeric('line_total_with_tax', { precision: 18, scale: 2 }),
  accountId: varchar('account_id', { length: 30 }),
  productId: varchar('product_id', { length: 30 }),
  period: jsonb('period').$type<{ from?: string; to?: string }>(),
  sortOrder: integer('sort_order').default(0),
  /** WeldBooks product tax code (general, saas, shipping, ...); falls back to the product's tax class. */
  taxCode: varchar('tax_code', { length: 30 }),
  /** business | personal: some states tax a product for only one of them. Defaults to the customer's. */
  taxUse: varchar('tax_use', { length: 10 }),
  /** The price includes the tax; it is backed out of the line. */
  taxIncluded: boolean('tax_included').default(false),
  /** Tax the user set by hand; kept across recalculations of the draft. */
  taxOverrideAmount: numeric('tax_override_amount', { precision: 18, scale: 2 }),
  taxOverrideReason: varchar('tax_override_reason', { length: 255 }),
  classId: varchar('class_id', { length: 30 }),
  locationId: varchar('location_id', { length: 30 }),
}, (table) => [
  index('acct_invoice_items_entity_idx').on(table.entityId),
  index('acct_invoice_items_invoice_idx').on(table.invoiceId),
]);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type NewInvoiceItem = typeof invoiceItems.$inferInsert;
