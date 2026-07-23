import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';

// Track product syncs to external platforms (Shopify, WooCommerce, etc.)
export const productConnections = pgTable('product_connections', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Product Reference
  productId: varchar('product_id', { length: 30 }).notNull(),

  // External Platform
  platform: varchar('platform', { length: 50 }).notNull(),
  connectionId: varchar('connection_id', { length: 30 }).notNull(),

  // External IDs
  externalProductId: varchar('external_product_id', { length: 255 }),
  externalVariantIds: jsonb('external_variant_ids').$type<string[]>(),

  // Sync Status
  syncStatus: varchar('sync_status', { length: 30 }).default('pending'),
  lastSyncedAt: timestamp('last_synced_at'),
  lastSyncError: varchar('last_sync_error', { length: 500 }),

  // Sync Settings
  syncInventory: integer('sync_inventory').default(1),
  syncPrices: integer('sync_prices').default(1),
  syncImages: integer('sync_images').default(1),
  syncDescription: integer('sync_description').default(1),

  // External URL
  externalUrl: varchar('external_url', { length: 500 }),

  // Metadata
  externalMetadata: jsonb('external_metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('product_connections_product_idx').on(table.productId),
  index('product_connections_platform_idx').on(table.platform),
  index('product_connections_connection_idx').on(table.connectionId),
]);

export type ProductConnection = typeof productConnections.$inferSelect;
export type NewProductConnection = typeof productConnections.$inferInsert;

// Backwards compatibility
export { productConnections as commerceProductConnections };
export type CommerceProductConnection = ProductConnection;
export type NewCommerceProductConnection = NewProductConnection;
