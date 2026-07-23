import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

export interface QuoteLineItem {
  id: string;
  productId?: string;
  productName: string;
  description?: string;
  quantity: number;
  unitPrice: { amount: number; currency: string };
  discount?: number;
  tax?: { amount: number; currency: string };
  total: { amount: number; currency: string };
}

export const crmQuotes = pgTable('crm_quotes', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  quoteNumber: varchar('quote_number', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),

  // Customer
  customerId: varchar('customer_id', { length: 30 }).notNull(),
  contactId: varchar('contact_id', { length: 30 }),
  // New shape — populated by migration backfill.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),
  opportunityId: varchar('opportunity_id', { length: 30 }),

  // Details
  lineItems: jsonb('line_items').$type<QuoteLineItem[]>().notNull(), // QuoteLineItem[]

  // Pricing (using numeric for money precision)
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).notNull().default('0'),
  discount: numeric('discount', { precision: 18, scale: 2 }),
  tax: numeric('tax', { precision: 18, scale: 2 }),
  shipping: numeric('shipping', { precision: 18, scale: 2 }),
  total: numeric('total', { precision: 18, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).default('EUR'),

  // Validity
  validFrom: timestamp('valid_from').notNull(),
  validUntil: timestamp('valid_until').notNull(),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('draft'), // 'draft' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired' | 'revised'

  // Terms
  paymentTerms: varchar('payment_terms', { length: 255 }),
  deliveryTerms: varchar('delivery_terms', { length: 255 }),
  termsAndConditions: text('terms_and_conditions'),

  // Approval
  requiresApproval: boolean('requires_approval').default(false),
  approvedBy: varchar('approved_by', { length: 255 }), // Clerk user ID
  approvedAt: timestamp('approved_at'),

  // Signature
  signatureRequired: boolean('signature_required').default(false),
  signedBy: varchar('signed_by', { length: 255 }),
  signedAt: timestamp('signed_at'),
  signatureUrl: varchar('signature_url', { length: 1000 }),

  // Documents
  pdfUrl: varchar('pdf_url', { length: 1000 }),
  sentAt: timestamp('sent_at'),
  viewedAt: timestamp('viewed_at'),

  // Notes
  notes: text('notes'),
  internalNotes: text('internal_notes'),
}, (table) => [
  index('crm_quotes_quote_number_idx').on(table.quoteNumber),
  index('crm_quotes_customer_idx').on(table.customerId),
  index('crm_quotes_counterparty_idx').on(table.counterpartyId),
  index('crm_quotes_person_idx').on(table.personId),
  index('crm_quotes_opportunity_idx').on(table.opportunityId),
  index('crm_quotes_status_idx').on(table.status),
  index('crm_quotes_valid_until_idx').on(table.validUntil),
]);

export type CrmQuote = typeof crmQuotes.$inferSelect;
export type NewCrmQuote = typeof crmQuotes.$inferInsert;
