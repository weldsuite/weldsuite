import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

// Variant rows for products.hasVariants — one per combination of products.options.
// Referenced by order_items.variant_id.
export const productVariants = pgTable('product_variants', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Parent
  productId: varchar('product_id', { length: 30 }).notNull(),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  sku: varchar('sku', { length: 100 }),
  barcode: varchar('barcode', { length: 100 }),

  // Selected value for each entry in products.options, e.g. [{ name: 'Size', value: 'L' }]
  optionValues: jsonb('option_values').$type<Array<{ name: string; value: string }>>(),

  // Pricing — null falls back to the parent product's price
  price: numeric('price', { precision: 18, scale: 2 }),
  compareAtPrice: numeric('compare_at_price', { precision: 18, scale: 2 }),
  costPrice: numeric('cost_price', { precision: 18, scale: 2 }),
  currency: varchar('currency', { length: 3 }).default('USD'),

  // Inventory
  trackInventory: boolean('track_inventory').default(true),
  inventoryQuantity: integer('inventory_quantity').default(0),
  lowStockThreshold: integer('low_stock_threshold').default(5),
  allowBackorder: boolean('allow_backorder').default(false),

  // Physical Properties
  weight: numeric('weight', { precision: 10, scale: 3 }),
  weightUnit: varchar('weight_unit', { length: 10 }).default('kg'),
  length: numeric('length', { precision: 10, scale: 2 }),
  width: numeric('width', { precision: 10, scale: 2 }),
  height: numeric('height', { precision: 10, scale: 2 }),
  dimensionUnit: varchar('dimension_unit', { length: 10 }).default('cm'),

  // Shipping
  requiresShipping: boolean('requires_shipping').default(true),

  // Media
  imageUrl: varchar('image_url', { length: 500 }),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('active'),
  position: integer('position').default(0),

  // Attributes
  attributes: jsonb('attributes').$type<Record<string, unknown>>(),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('product_variants_product_idx').on(table.productId),
  index('product_variants_sku_idx').on(table.sku),
  index('product_variants_barcode_idx').on(table.barcode),
  index('product_variants_status_idx').on(table.status),
]);

export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;
