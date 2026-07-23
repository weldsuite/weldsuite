import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

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

  // Product count
  productCount: integer('product_count').default(0),

  // Custom fields
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),
}, (table) => [
  index('categories_slug_idx').on(table.slug),
  index('categories_parent_idx').on(table.parentId),
  index('categories_path_idx').on(table.path),
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
]);

export type CategoryProduct = typeof categoryProducts.$inferSelect;
export type NewCategoryProduct = typeof categoryProducts.$inferInsert;
