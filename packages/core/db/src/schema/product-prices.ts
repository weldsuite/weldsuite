import { sql } from 'drizzle-orm';
import { pgTable, varchar, timestamp, numeric, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Price and compare-at price of a product or variant per currency (rebuild,
// phase 4; ADR COM-011). `products.price` / `products.currency` stay the base
// price; a channel sells a product only when it has a price in the channel's
// currency. Prices are never converted between currencies.
export const productPrices = pgTable('product_prices', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  productId: varchar('product_id', { length: 30 }).notNull(),
  // Null: the price of the product itself; set: the price of that variant.
  variantId: varchar('variant_id', { length: 30 }),
  currency: varchar('currency', { length: 3 }).notNull(),
  price: numeric('price', { precision: 18, scale: 2 }).notNull(),
  compareAtPrice: numeric('compare_at_price', { precision: 18, scale: 2 }),
}, (table) => [
  index('product_prices_product_idx').on(table.productId),
  index('product_prices_variant_idx').on(table.variantId),
  // One live price per (product, variant or none, currency).
  uniqueIndex('product_prices_product_currency_uidx')
    .on(table.productId, table.currency)
    .where(sql`${table.variantId} IS NULL AND ${table.deletedAt} IS NULL`),
  uniqueIndex('product_prices_variant_currency_uidx')
    .on(table.productId, table.variantId, table.currency)
    .where(sql`${table.variantId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
]);

export type ProductPrice = typeof productPrices.$inferSelect;
export type NewProductPrice = typeof productPrices.$inferInsert;
