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
]);

export type Discount = typeof discounts.$inferSelect;
export type NewDiscount = typeof discounts.$inferInsert;
