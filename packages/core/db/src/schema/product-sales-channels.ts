import {
  pgTable,
  varchar,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { products } from './products';
import { connectorConnections } from './connector-connections';

/**
 * One listing of a WeldCommerce product on an external store.
 *
 * The product row is the canonical catalogue item. This sibling record says
 * which connector it came from (or is published to) and the external id on
 * that store — so two WooCommerce shops can share one SKU without colliding.
 *
 * `status` is the mapping health (is the connection still live?).
 * `listingStatus` is the storefront state of this listing (published, draft,
 * or inactive), which can differ from the catalogue product and from other
 * channels. `price` is the price pushed to that store.
 */
export type ProductSalesChannelStatus = 'active' | 'disconnected' | 'deleted_remote';
export type ProductSalesChannelListingStatus = 'active' | 'inactive' | 'draft';

export const productSalesChannels = pgTable(
  'product_sales_channels',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    productId: varchar('product_id', { length: 30 })
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    connectionId: varchar('connection_id', { length: 30 })
      .notNull()
      .references(() => connectorConnections.id, { onDelete: 'cascade' }),

    /** Catalog provider id, e.g. `woocommerce` / `shopify`. */
    provider: varchar('provider', { length: 100 }).notNull(),
    /** Tenant-facing store label copied from the connection. */
    displayName: varchar('display_name', { length: 255 }),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    externalUrl: varchar('external_url', { length: 500 }),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('active')
      .$type<ProductSalesChannelStatus>(),
    /** Price on this store. Null means inherit the catalogue product price. */
    price: numeric('price', { precision: 18, scale: 2 }),
    listingStatus: varchar('listing_status', { length: 20 })
      .notNull()
      .default('active')
      .$type<ProductSalesChannelListingStatus>(),
    lastSyncedAt: timestamp('last_synced_at'),
  },
  (table) => [
    uniqueIndex('product_sales_channels_connection_external_unique').on(
      table.connectionId,
      table.externalId,
    ),
    uniqueIndex('product_sales_channels_product_connection_unique').on(
      table.productId,
      table.connectionId,
    ),
    index('product_sales_channels_product_idx').on(table.productId),
    index('product_sales_channels_connection_idx').on(table.connectionId),
    index('product_sales_channels_provider_idx').on(table.provider),
  ],
);

export type ProductSalesChannel = typeof productSalesChannels.$inferSelect;
export type NewProductSalesChannel = typeof productSalesChannels.$inferInsert;
