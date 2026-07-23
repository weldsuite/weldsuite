import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

// Purchase Order Items - Line items in purchase orders
export const purchaseOrderItems = pgTable('purchase_order_items', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  purchaseOrderId: varchar('purchase_order_id', { length: 30 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Product Reference
  productId: varchar('product_id', { length: 30 }),
  variantId: varchar('variant_id', { length: 30 }),
  sku: varchar('sku', { length: 100 }),

  // Item Details
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Quantities
  quantityOrdered: integer('quantity_ordered').notNull().default(1),
  quantityReceived: integer('quantity_received').default(0),
  quantityPending: integer('quantity_pending').default(0),
  quantityRejected: integer('quantity_rejected').default(0),

  // Pricing
  unitPrice: numeric('unit_price', { precision: 18, scale: 2 }).notNull(),
  discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).default('0'),
  discountAmount: numeric('discount_amount', { precision: 18, scale: 2 }).default('0'),
  taxPercent: numeric('tax_percent', { precision: 5, scale: 2 }).default('0'),
  taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }).default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).notNull(),

  // Receiving
  lastReceivedDate: timestamp('last_received_date'),
  destinationLocationId: varchar('destination_location_id', { length: 30 }),

  // Lot/Batch (expected)
  expectedLotNumber: varchar('expected_lot_number', { length: 100 }),
  expectedExpiryDate: timestamp('expected_expiry_date'),

  // Notes
  notes: text('notes'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('po_items_po_idx').on(table.purchaseOrderId),
  index('po_items_product_idx').on(table.productId),
]);

export type PurchaseOrderItem = typeof purchaseOrderItems.$inferSelect;
export type NewPurchaseOrderItem = typeof purchaseOrderItems.$inferInsert;
