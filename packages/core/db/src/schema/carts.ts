import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  numeric,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Storefront carts and their checkout state (rebuild, phase 4; ADR COM-011).
// The shop reaches a cart by an opaque cart token (`wct_...`) it gets once, when
// the cart is created. Only the SHA-256 of the token is stored (`token_hash`);
// `id` is never sent as the credential.

export type CartStatus = 'open' | 'checkout' | 'completed' | 'abandoned' | 'expired';

export interface CartAddress {
  name?: string;
  company?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  // ISO 3166-1 alpha-2.
  country?: string;
  phone?: string;
}

export const carts = pgTable('carts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // SHA-256 (hex) of the cart token.
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  channelId: varchar('channel_id', { length: 30 }).notNull(),
  // 'open' | 'checkout' | 'completed' | 'abandoned' | 'expired'
  status: varchar('status', { length: 20 }).$type<CartStatus>().notNull().default('open'),
  currency: varchar('currency', { length: 3 }).notNull(),
  pricesIncludeTax: boolean('prices_include_tax').notNull().default(true),

  // Who: the signed-in shopper (a CRM person, `in_crm = false` for web shoppers),
  // for B2B the company ordered for and the buyer row that placed it.
  personId: varchar('person_id', { length: 30 }),
  companyId: varchar('company_id', { length: 30 }),
  buyerId: varchar('buyer_id', { length: 30 }),
  email: varchar('email', { length: 255 }),

  billingAddress: jsonb('billing_address').$type<CartAddress>(),
  shippingAddress: jsonb('shipping_address').$type<CartAddress>(),
  // ISO country the goods go to; drives the VAT treatment.
  destinationCountry: varchar('destination_country', { length: 2 }),
  shippingRateId: varchar('shipping_rate_id', { length: 30 }),

  discountId: varchar('discount_id', { length: 30 }),
  discountCode: varchar('discount_code', { length: 100 }),

  buyerVatNumber: varchar('buyer_vat_number', { length: 50 }),
  // The last VAT quote from the WeldBooks engine (lines, rates, reverse charge flags) and its treatment.
  vatTreatment: varchar('vat_treatment', { length: 30 }),
  vatQuote: jsonb('vat_quote').$type<Record<string, unknown>>(),
  customerReference: varchar('customer_reference', { length: 100 }),
  note: varchar('note', { length: 1000 }),

  // Totals snapshot of the last quote, in the cart currency.
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }).notNull().default('0'),
  discountTotal: numeric('discount_total', { precision: 18, scale: 2 }).notNull().default('0'),
  shippingTotal: numeric('shipping_total', { precision: 18, scale: 2 }).notNull().default('0'),
  taxTotal: numeric('tax_total', { precision: 18, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 18, scale: 2 }).notNull().default('0'),

  expiresAt: timestamp('expires_at'),
  // The order the cart became, and when.
  orderId: varchar('order_id', { length: 30 }),
  completedAt: timestamp('completed_at'),
  // Client-supplied key that makes placing the order safe to retry.
  idempotencyKey: varchar('idempotency_key', { length: 100 }),
}, (table) => [
  uniqueIndex('carts_token_hash_uidx').on(table.tokenHash),
  index('carts_channel_status_idx').on(table.channelId, table.status),
  index('carts_person_idx').on(table.personId),
  index('carts_company_idx').on(table.companyId),
  index('carts_order_idx').on(table.orderId),
  // Expiry sweeps touch only carts that can still expire.
  index('carts_expires_at_idx').on(table.expiresAt).where(sql`${table.status} IN ('open', 'checkout')`),
  uniqueIndex('carts_idempotency_key_uidx')
    .on(table.channelId, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
]);

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;

export const cartItems = pgTable('cart_items', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  cartId: varchar('cart_id', { length: 30 }).notNull(),
  productId: varchar('product_id', { length: 30 }).notNull(),
  variantId: varchar('variant_id', { length: 30 }),
  // Snapshot at add time, for display; checkout re-reads the live price.
  sku: varchar('sku', { length: 100 }),
  name: varchar('name', { length: 255 }),
  quantity: integer('quantity').notNull().default(1),
  unitPrice: numeric('unit_price', { precision: 18, scale: 2 }),
  properties: jsonb('properties').$type<Record<string, unknown>>(),
}, (table) => [
  index('cart_items_cart_idx').on(table.cartId),
  index('cart_items_product_idx').on(table.productId),
  // One line per product (or variant) in a cart; adding again raises the quantity.
  uniqueIndex('cart_items_cart_product_uidx')
    .on(table.cartId, table.productId)
    .where(sql`${table.variantId} IS NULL`),
  uniqueIndex('cart_items_cart_variant_uidx')
    .on(table.cartId, table.productId, table.variantId)
    .where(sql`${table.variantId} IS NOT NULL`),
]);

export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;
