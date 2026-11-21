import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  numeric,
  boolean,
  index,
  uniqueIndex,
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

  // WeldCommerce (rebuild, phase 2)
  // Sales channel the order came in through (phase 5 adds the channels table).
  channelId: varchar('channel_id', { length: 30 }),
  // Legal entity that sells the order (WeldBooks invoices it).
  entityId: varchar('entity_id', { length: 30 }),
  // True when line prices already include VAT.
  pricesIncludeTax: boolean('prices_include_tax').notNull().default(false),
  // ISO 3166-1 alpha-2 country the goods go to; drives the VAT treatment.
  destinationCountry: varchar('destination_country', { length: 2 }),
  buyerVatNumber: varchar('buyer_vat_number', { length: 50 }),
  vatTreatment: varchar('vat_treatment', { length: 30 }),
  // The buyer's own PO number.
  customerReference: varchar('customer_reference', { length: 100 }),
  // 'not_required' | 'pending' | 'approved' | 'rejected'
  approvalStatus: varchar('approval_status', { length: 20 }).notNull().default('not_required'),
  placedByPersonId: varchar('placed_by_person_id', { length: 30 }),
  // Client-supplied key that makes order creation safe to retry.
  idempotencyKey: varchar('idempotency_key', { length: 100 }),
  // SHA-256 (hex) of the guest order link token (COM-012): a guest sees only that one order.
  guestAccessTokenHash: varchar('guest_access_token_hash', { length: 64 }),
}, (table) => [
  index('orders_order_number_idx').on(table.orderNumber),
  index('orders_customer_idx').on(table.customerId),
  index('orders_counterparty_idx').on(table.counterpartyId),
  index('orders_person_idx').on(table.personId),
  index('orders_status_idx').on(table.status),
  index('orders_payment_status_idx').on(table.paymentStatus),
  index('orders_created_at_idx').on(table.createdAt),
  index('orders_channel_idx').on(table.channelId),
  uniqueIndex('orders_guest_access_token_uidx')
    .on(table.guestAccessTokenHash)
    .where(sql`${table.guestAccessTokenHash} IS NOT NULL`),
  uniqueIndex('orders_idempotency_key_uidx')
    .on(table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
  // WeldCommerce's own order numbers (manual and storefront orders, numbered
  // from commerce_settings) are unique within their source among live
  // orders. Imported orders keep their store's number: two stores of the
  // same provider may both have a #1001.
  uniqueIndex('orders_native_order_number_uidx')
    .on(table.source, table.orderNumber)
    .where(sql`${table.deletedAt} IS NULL AND ${table.source} IN ('manual', 'storefront')`),
]);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

// Order Items (Line Items)
export const orderItems = pgTable('order_items', {
  id: varchar('id', { length: 30 }).primaryKey(),
  orderId: varchar('order_id', { length: 30 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

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
  // VAT category of the line ('standard', 'reduced', ...) and the rate applied, in percent.
  vatCategory: varchar('vat_category', { length: 30 }),
  taxRate: numeric('tax_rate', { precision: 7, scale: 4 }),
  total: numeric('total', { precision: 18, scale: 2 }).notNull(),

  // Weight
  weight: numeric('weight', { precision: 10, scale: 3 }),

  // Fulfillment
  fulfilledQuantity: integer('fulfilled_quantity').default(0),
  requiresShipping: integer('requires_shipping').default(1),

  // Customization
  properties: jsonb('properties').$type<Record<string, unknown>>(),

  // The provider's line id for imported orders (was properties.externalLineId).
  externalLineId: varchar('external_line_id', { length: 100 }),
}, (table) => [
  index('order_items_order_idx').on(table.orderId),
  index('order_items_order_external_line_idx').on(table.orderId, table.externalLineId),
  index('order_items_product_idx').on(table.productId),
]);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
