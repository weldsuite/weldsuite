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

// Shared orders table
export const orders = pgTable('orders', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Order Identification
  orderNumber: varchar('order_number', { length: 50 }).notNull(),
  externalOrderId: varchar('external_order_id', { length: 100 }),

  // Customer (legacy — kept during Companies/People migration)
  customerId: varchar('customer_id', { length: 30 }),
  customerEmail: varchar('customer_email', { length: 255 }),
  customerName: varchar('customer_name', { length: 255 }),
  customerPhone: varchar('customer_phone', { length: 50 }),

  // Counterparty + person (new — populated by migration backfill).
  // For b2c orders the counterparty is the buying Person's wrapping party;
  // for b2b orders the counterparty is the buying Company and personId
  // identifies the human who placed the order.
  counterpartyId: varchar('counterparty_id', { length: 30 }),
  personId: varchar('person_id', { length: 30 }),

  // Status
  status: varchar('status', { length: 30 }).notNull().default('pending'),
  paymentStatus: varchar('payment_status', { length: 30 }).default('pending'),
  fulfillmentStatus: varchar('fulfillment_status', { length: 30 }).default('unfulfilled'),

  // Totals
  currency: varchar('currency', { length: 3 }).default('USD'),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).notNull().default('0'),
  discountTotal: numeric('discount_total', { precision: 18, scale: 2 }).default('0'),
  shippingTotal: numeric('shipping_total', { precision: 18, scale: 2 }).default('0'),
  taxTotal: numeric('tax_total', { precision: 18, scale: 2 }).default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).notNull().default('0'),

  // Tax Details
  taxLines: jsonb('tax_lines').$type<Array<{ title: string; rate: number; price: string }>>(),
  taxExempt: integer('tax_exempt').default(0),

  // Addresses
  billingAddress: jsonb('billing_address').$type<{
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    name?: string;
    phone?: string;
  }>(),
  shippingAddress: jsonb('shipping_address').$type<{
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    name?: string;
    phone?: string;
  }>(),

  // Shipping
  shippingMethod: varchar('shipping_method', { length: 100 }),
  shippingCarrier: varchar('shipping_carrier', { length: 100 }),
  trackingNumber: varchar('tracking_number', { length: 255 }),
  trackingUrl: varchar('tracking_url', { length: 500 }),
  shippedAt: timestamp('shipped_at'),
  deliveredAt: timestamp('delivered_at'),

  // Payment
  paymentMethod: varchar('payment_method', { length: 100 }),
  paymentReference: varchar('payment_reference', { length: 255 }),
  paidAt: timestamp('paid_at'),

  // Discount
  discountCode: varchar('discount_code', { length: 100 }),
  discountId: varchar('discount_id', { length: 30 }),

  // Notes
  customerNote: text('customer_note'),
  internalNote: text('internal_note'),

  // Item Summary
  itemCount: integer('item_count').default(0),
  totalQuantity: integer('total_quantity').default(0),

  // Source
  source: varchar('source', { length: 50 }).default('web'),
  sourceOrderId: varchar('source_order_id', { length: 100 }),

  // Dates
  cancelledAt: timestamp('cancelled_at'),
  cancelReason: varchar('cancel_reason', { length: 500 }),
  completedAt: timestamp('completed_at'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  tags: jsonb('tags').$type<string[]>(),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('orders_order_number_idx').on(table.orderNumber),
  index('orders_customer_idx').on(table.customerId),
  index('orders_counterparty_idx').on(table.counterpartyId),
  index('orders_person_idx').on(table.personId),
  index('orders_status_idx').on(table.status),
  index('orders_payment_status_idx').on(table.paymentStatus),
  index('orders_created_at_idx').on(table.createdAt),
]);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

// Order Items (Line Items)
export const orderItems = pgTable('order_items', {
  id: varchar('id', { length: 30 }).primaryKey(),
  orderId: varchar('order_id', { length: 30 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Product Reference
  productId: varchar('product_id', { length: 30 }),
  variantId: varchar('variant_id', { length: 30 }),
  sku: varchar('sku', { length: 100 }),

  // Item Details
  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 500 }),
  imageUrl: varchar('image_url', { length: 500 }),

  // Quantity & Pricing
  quantity: integer('quantity').notNull().default(1),
  unitPrice: numeric('unit_price', { precision: 18, scale: 2 }).notNull(),
  discountAmount: numeric('discount_amount', { precision: 18, scale: 2 }).default('0'),
  taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }).default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).notNull(),

  // Weight
  weight: numeric('weight', { precision: 10, scale: 3 }),

  // Fulfillment
  fulfilledQuantity: integer('fulfilled_quantity').default(0),
  requiresShipping: integer('requires_shipping').default(1),

  // Customization
  properties: jsonb('properties').$type<Record<string, unknown>>(),
}, (table) => [
  index('order_items_order_idx').on(table.orderId),
  index('order_items_product_idx').on(table.productId),
]);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
