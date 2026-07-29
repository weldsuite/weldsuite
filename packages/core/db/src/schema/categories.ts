import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * One rule in an automated category's membership query.
 *
 * `column` is validated against a server-side whitelist before it ever reaches
 * SQL (see app-api services/product-categories.ts) — it names a product field,
 * never a raw identifier. `condition` is always bound as a parameter.
 */
export interface CategoryRule {
  column: string;
  relation: string;
  condition: string;
}

// Shared categories table
export const categories = pgTable('categories', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull(),
  description: text('description'),

  // Hierarchy
  parentId: varchar('parent_id', { length: 30 }),
  path: varchar('path', { length: 500 }),
  depth: integer('depth').default(0),

  // Display
  position: integer('position').default(0),
  image: varchar('image', { length: 500 }),
  icon: varchar('icon', { length: 100 }),
  color: varchar('color', { length: 20 }),

  // SEO
  metaTitle: varchar('meta_title', { length: 255 }),
  metaDescription: varchar('meta_description', { length: 500 }),

  // Status
  isActive: integer('is_active').default(1),
  // Publication is separate from `isActive`: a category can be active but not
  // yet published (scheduled), or published historically and since deactivated.
  publishedAt: timestamp('published_at'),

  // Membership
  // `manual`    — members come from `category_products`.
  // `automated` — members are whatever `rules` currently match; there is no
  //               stored membership, so a new product joins the moment it
  //               matches rather than on the next sync.
  type: varchar('type', { length: 20 }).default('manual'),
  rules: jsonb('rules').$type<CategoryRule[]>(),
  rulesMatch: varchar('rules_match', { length: 3 }).default('all'), // all | any

  // How members are ordered when listed:
  // manual | best-selling | alpha-asc | alpha-desc | price-asc | price-desc |
  // created-desc | created-asc. `manual` only means anything for manual
  // categories, where it falls back to `category_products.position`.
  sortOrder: varchar('sort_order', { length: 20 }).default('manual'),

  // Product count
  // Denormalised and NOT maintained — it cannot be kept correct for automated
  // categories, whose membership changes whenever a product does. Read the
  // `totalCount` from GET /api/categories/:id/products instead.
  productCount: integer('product_count').default(0),

  // Custom fields
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),
}, (table) => [
  index('categories_slug_idx').on(table.slug),
  index('categories_parent_idx').on(table.parentId),
  index('categories_path_idx').on(table.path),
  index('categories_type_idx').on(table.type),
]);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

// Junction table for product-category relationships
export const categoryProducts = pgTable('category_products', {
  id: varchar('id', { length: 30 }).primaryKey(),
  categoryId: varchar('category_id', { length: 30 }).notNull(),
  productId: varchar('product_id', { length: 30 }).notNull(),
  position: integer('position').default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('category_products_category_idx').on(table.categoryId),
  index('category_products_product_idx').on(table.productId),
  // A product belongs to a category once. Without this, a double-submit on
  // "add to category" silently duplicates the row and the product appears
  // twice in every listing.
  uniqueIndex('category_products_unique').on(table.categoryId, table.productId),
]);

export type CategoryProduct = typeof categoryProducts.$inferSelect;
export type NewCategoryProduct = typeof categoryProducts.$inferInsert;
