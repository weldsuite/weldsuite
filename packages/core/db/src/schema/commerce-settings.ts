import { pgTable, varchar, timestamp, bigint, boolean } from 'drizzle-orm/pg-core';

// WeldCommerce settings: one row per tenant database, created on first read.
// Later phases add columns (channels, tax defaults, approvals, ...).
export const commerceSettings = pgTable('commerce_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Order numbers are prefix + sequence, e.g. 'WC-1001'.
  orderNumberPrefix: varchar('order_number_prefix', { length: 20 }).notNull().default('WC-'),
  // The next number to hand out. `bigint(mode: 'number')`, per the
  // ai-gateway-costs.ts convention (values stay far below 2^53).
  nextOrderNumber: bigint('next_order_number', { mode: 'number' }).notNull().default(1001),
  defaultCurrency: varchar('default_currency', { length: 3 }).notNull().default('EUR'),

  // Legal entity (WeldBooks) that invoices the orders; null uses the workspace's default entity.
  defaultEntityId: varchar('default_entity_id', { length: 30 }),
  // A paid (or pay-on-invoice) order becomes a finalised WeldBooks invoice, a refund a credit note (COM-013).
  autoInvoice: boolean('auto_invoice').notNull().default(true),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type CommerceSettings = typeof commerceSettings.$inferSelect;
export type NewCommerceSettings = typeof commerceSettings.$inferInsert;
