import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Discount definitions backing orders.discount_id / orders.discount_code.
export const discounts = pgTable('discounts', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Redemption code — null for automatic discounts applied without a code
  code: varchar('code', { length: 100 }),

  // 'percentage' | 'fixed_amount' | 'free_shipping'
  type: varchar('type', { length: 30 }).notNull(),
  // Percent (0-100) for 'percentage', money amount for 'fixed_amount', unused for 'free_shipping'
  value: numeric('value', { precision: 18, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).default('USD'),
  // Caps the computed amount for percentage discounts
  maxDiscountAmount: numeric('max_discount_amount', { precision: 18, scale: 2 }),

  // Scope — 'all' | 'products' | 'categories'
  appliesTo: varchar('applies_to', { length: 20 }).notNull().default('all'),
  productIds: jsonb('product_ids').$type<string[]>(),
  variantIds: jsonb('variant_ids').$type<string[]>(),
  categoryIds: jsonb('category_ids').$type<string[]>(),

  // Conditions
  minimumSubtotal: numeric('minimum_subtotal', { precision: 18, scale: 2 }),
  minimumQuantity: integer('minimum_quantity'),

  // Usage limits — null means unlimited
  usageLimit: integer('usage_limit'),
  usageLimitPerCustomer: integer('usage_limit_per_customer'),
  usageCount: integer('usage_count').default(0),
  oncePerCustomer: boolean('once_per_customer').default(false),

  // Eligibility — 'all' | 'customers' | 'new_customers'
  customerEligibility: varchar('customer_eligibility', { length: 20 }).default('all'),
  customerIds: jsonb('customer_ids').$type<string[]>(),

  // Stacking
  combinesWithOtherDiscounts: boolean('combines_with_other_discounts').default(false),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('draft'),

  // Window — null endsAt means no expiry
  startsAt: timestamp('starts_at'),
  endsAt: timestamp('ends_at'),

  // Custom fields
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('discounts_code_idx').on(table.code),
  index('discounts_status_idx').on(table.status),
  index('discounts_type_idx').on(table.type),
  index('discounts_ends_at_idx').on(table.endsAt),
  // A code is unique (case-insensitive, trimmed) among live, non-archived discounts.
  uniqueIndex('discounts_code_uidx')
    .on(sql`lower(trim(${table.code}))`)
    .where(sql`${table.code} IS NOT NULL AND ${table.deletedAt} IS NULL AND ${table.status} <> 'archived'`),
]);

export type Discount = typeof discounts.$inferSelect;
export type NewDiscount = typeof discounts.$inferInsert;

// One row per discount applied to an order. Written in the same transaction as
// the order and the discounts.usage_count bump.
export const discountRedemptions = pgTable('discount_redemptions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  discountId: varchar('discount_id', { length: 30 }).notNull(),
  orderId: varchar('order_id', { length: 30 }).notNull(),
  personId: varchar('person_id', { length: 30 }),
  customerEmail: varchar('customer_email', { length: 255 }),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('discount_redemptions_discount_idx').on(table.discountId),
  index('discount_redemptions_order_idx').on(table.orderId),
  index('discount_redemptions_person_idx').on(table.personId),
  index('discount_redemptions_email_idx').on(sql`lower(${table.customerEmail}::text)`),
  uniqueIndex('discount_redemptions_discount_order_uidx').on(table.discountId, table.orderId),
]);

export type DiscountRedemption = typeof discountRedemptions.$inferSelect;
export type NewDiscountRedemption = typeof discountRedemptions.$inferInsert;
