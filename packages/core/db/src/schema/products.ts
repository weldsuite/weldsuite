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

// Shared products table (Commerce, WMS, etc.)
export const products = pgTable('products', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull(),
  sku: varchar('sku', { length: 100 }),
  barcode: varchar('barcode', { length: 100 }),
  description: text('description'),
  shortDescription: varchar('short_description', { length: 500 }),

  // Pricing
  price: numeric('price', { precision: 18, scale: 2 }).notNull().default('0'),
  compareAtPrice: numeric('compare_at_price', { precision: 18, scale: 2 }),
  costPrice: numeric('cost_price', { precision: 18, scale: 2 }),
  currency: varchar('currency', { length: 3 }).default('USD'),

  // Inventory
  trackInventory: boolean('track_inventory').default(true),
  // Denormalised roll-up of `inventory.quantity_on_hand` across every warehouse,
  // location and lot for this product. Maintained by the stock ledger
  // (app-api services/inventory-ledger.ts) — never write it directly, or it
  // drifts from the inventory rows that are the real source of truth.
  inventoryQuantity: integer('inventory_quantity').default(0),
  lowStockThreshold: integer('low_stock_threshold').default(5),
  allowBackorder: boolean('allow_backorder').default(false),

  // Lot / serial / expiry tracking — opt-in per product. The stock ledger only
  // demands a lot number (or serial, or expiry date) on receipt when the
  // product opts in, so products that don't need traceability stay frictionless.
  trackLots: boolean('track_lots').default(false),
  trackSerials: boolean('track_serials').default(false),
  trackExpiry: boolean('track_expiry').default(false),

  // Physical Properties
  weight: numeric('weight', { precision: 10, scale: 3 }),
  weightUnit: varchar('weight_unit', { length: 10 }).default('kg'),
  length: numeric('length', { precision: 10, scale: 2 }),
  width: numeric('width', { precision: 10, scale: 2 }),
  height: numeric('height', { precision: 10, scale: 2 }),
  dimensionUnit: varchar('dimension_unit', { length: 10 }).default('cm'),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  visibility: varchar('visibility', { length: 20 }).default('visible'),

  // SEO
  metaTitle: varchar('meta_title', { length: 255 }),
  metaDescription: varchar('meta_description', { length: 500 }),
  metaKeywords: jsonb('meta_keywords').$type<string[]>(),

  // Media
  images: jsonb('images').$type<Array<{ url: string; altText?: string; id?: string }>>(),
  featuredImageUrl: varchar('featured_image_url', { length: 500 }),

  // Taxonomy
  productType: varchar('product_type', { length: 100 }),
  vendor: varchar('vendor', { length: 255 }),
  brand: varchar('brand', { length: 255 }),

  // Tax
  taxable: boolean('taxable').default(true),
  taxClass: varchar('tax_class', { length: 50 }),

  // Shipping
  requiresShipping: boolean('requires_shipping').default(true),
  shippingClass: varchar('shipping_class', { length: 50 }),

  // Options & Variants
  hasVariants: boolean('has_variants').default(false),
  options: jsonb('options').$type<Array<{ id?: string; name: string; values: string[] }>>(),
  variantCount: integer('variant_count').default(0),

  // Tags & Attributes
  tags: jsonb('tags').$type<string[]>(),
  attributes: jsonb('attributes').$type<Record<string, unknown>>(),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

  // Analytics
  viewCount: integer('view_count').default(0),
  salesCount: integer('sales_count').default(0),
  rating: numeric('rating', { precision: 3, scale: 2 }),
  reviewCount: integer('review_count').default(0),

  // Dates
  publishedAt: timestamp('published_at'),

  // Creator
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('products_slug_idx').on(table.slug),
  index('products_sku_idx').on(table.sku),
  index('products_status_idx').on(table.status),
  index('products_product_type_idx').on(table.productType),
]);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
