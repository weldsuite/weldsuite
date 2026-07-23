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

// Purchase Orders - Orders to suppliers for receiving inventory
export const purchaseOrders = pgTable('purchase_orders', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  poNumber: varchar('po_number', { length: 50 }).notNull(),

  // Supplier
  supplierId: varchar('supplier_id', { length: 30 }),
  supplierName: varchar('supplier_name', { length: 255 }),

  // Warehouse (destination)
  warehouseId: varchar('warehouse_id', { length: 30 }),
  warehouseName: varchar('warehouse_name', { length: 255 }),

  // Status
  status: varchar('status', { length: 30 }).notNull().default('draft'), // draft, pending, approved, ordered, partial, received, cancelled, closed

  // Dates
  orderDate: timestamp('order_date'),
  expectedDate: timestamp('expected_date'),
  receivedDate: timestamp('received_date'),

  // Totals
  currency: varchar('currency', { length: 3 }).default('USD'),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).default('0'),
  taxTotal: numeric('tax_total', { precision: 18, scale: 2 }).default('0'),
  shippingTotal: numeric('shipping_total', { precision: 18, scale: 2 }).default('0'),
  discountTotal: numeric('discount_total', { precision: 18, scale: 2 }).default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).default('0'),

  // Item Counts
  itemCount: integer('item_count').default(0),
  totalQuantityOrdered: integer('total_quantity_ordered').default(0),
  totalQuantityReceived: integer('total_quantity_received').default(0),

  // Shipping
  shippingMethod: varchar('shipping_method', { length: 100 }),
  trackingNumber: varchar('tracking_number', { length: 255 }),

  // Payment
  paymentTerms: varchar('payment_terms', { length: 100 }),
  paymentStatus: varchar('payment_status', { length: 30 }).default('pending'), // pending, partial, paid

  // Notes
  supplierNotes: text('supplier_notes'),
  internalNotes: text('internal_notes'),

  // Approval
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  tags: jsonb('tags').$type<string[]>(),
}, (table) => [
  index('purchase_orders_po_number_idx').on(table.poNumber),
  index('purchase_orders_supplier_idx').on(table.supplierId),
  index('purchase_orders_warehouse_idx').on(table.warehouseId),
  index('purchase_orders_status_idx').on(table.status),
  index('purchase_orders_created_idx').on(table.createdAt),
]);

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrder = typeof purchaseOrders.$inferInsert;
