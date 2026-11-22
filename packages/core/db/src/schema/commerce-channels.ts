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

// WeldCommerce sales channels (rebuild, phase 4; ADR COM-011).
// A channel is a place the workspace sells: a storefront (B2C or B2B), manual /
// sales orders, or one connected store (Shopify, WooCommerce) for the order hub.
// `orders.channel_id` points here.

export type CommerceChannelType = 'storefront' | 'manual' | 'shopify' | 'woocommerce' | (string & {});
export type CommerceChannelAudience = 'b2c' | 'b2b';
export type CommerceChannelStatus = 'draft' | 'active' | 'archived';
export type CommercePaymentMethod = 'mollie' | 'invoice';

export const commerceChannels = pgTable('commerce_channels', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  name: varchar('name', { length: 255 }).notNull(),
  // 'storefront' | 'manual' | 'shopify' | 'woocommerce' | ...
  type: varchar('type', { length: 30 }).$type<CommerceChannelType>().notNull().default('storefront'),
  audience: varchar('audience', { length: 10 }).$type<CommerceChannelAudience>().notNull().default('b2c'),
  // 'draft' | 'active' | 'archived'
  status: varchar('status', { length: 20 }).$type<CommerceChannelStatus>().notNull().default('draft'),

  // One currency per channel; it sells a product only with a price in it (product_prices).
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
  // B2C channels show and enter prices including VAT, B2B channels excluding it.
  pricesIncludeTax: boolean('prices_include_tax').notNull().default(true),
  // ISO 3166-1 alpha-2 countries the channel ships to (EU only in milestone 1).
  sellingCountries: jsonb('selling_countries').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  guestCheckout: boolean('guest_checkout').notNull().default(true),
  // Payment methods offered at checkout: 'mollie' | 'invoice'.
  paymentMethods: jsonb('payment_methods').$type<CommercePaymentMethod[]>().notNull().default(sql`'["mollie"]'::jsonb`),

  // Connector channels: the connector connection (connector_connections.id) of the connected store.
  connectionId: varchar('connection_id', { length: 30 }),
}, (table) => [
  index('commerce_channels_type_idx').on(table.type),
  index('commerce_channels_status_idx').on(table.status),
  index('commerce_channels_connection_idx').on(table.connectionId),
  index('commerce_channels_created_idx').on(table.createdAt, table.id),
]);

export type CommerceChannel = typeof commerceChannels.$inferSelect;
export type NewCommerceChannel = typeof commerceChannels.$inferInsert;

// Flat shipping rates per zone (a set of countries) on a channel; no carrier rates in milestone 1.
export const commerceShippingRates = pgTable('commerce_shipping_rates', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  channelId: varchar('channel_id', { length: 30 }).notNull(),
  // The zone: ISO 3166-1 alpha-2 countries this rate applies to.
  zoneName: varchar('zone_name', { length: 255 }).notNull(),
  countries: jsonb('countries').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  name: varchar('name', { length: 255 }).notNull(),
  price: numeric('price', { precision: 18, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
  // Subtotal from which shipping is free; null means never free.
  freeShippingThreshold: numeric('free_shipping_threshold', { precision: 18, scale: 2 }),
  position: integer('position').notNull().default(0),
  active: boolean('active').notNull().default(true),
}, (table) => [
  index('commerce_shipping_rates_channel_idx').on(table.channelId, table.position),
]);

export type CommerceShippingRate = typeof commerceShippingRates.$inferSelect;
export type NewCommerceShippingRate = typeof commerceShippingRates.$inferInsert;

// The storefront keys of a channel (ADR COM-011). Only the SHA-256 of a key is
// stored; the master `storefront_key_registry` row with the same id finds the
// workspace from a key. Rotating creates a new row and revokes the old one.
export type StorefrontKeyKind = 'publishable' | 'private';

export const commerceChannelKeys = pgTable('commerce_channel_keys', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  channelId: varchar('channel_id', { length: 30 }).notNull(),
  // 'publishable' (wcp_, browsers) | 'private' (wcs_, the merchant's server)
  kind: varchar('kind', { length: 12 }).$type<StorefrontKeyKind>().notNull(),
  name: varchar('name', { length: 255 }),
  // SHA-256 (hex) of the key, and the first characters, shown to tell keys apart.
  keyHash: varchar('key_hash', { length: 64 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
  // Publishable keys only work from these origins.
  allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // The key this one replaced when rotated.
  rotatedFromId: varchar('rotated_from_id', { length: 30 }),
  createdBy: varchar('created_by', { length: 255 }),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
}, (table) => [
  uniqueIndex('commerce_channel_keys_hash_uidx').on(table.keyHash),
  index('commerce_channel_keys_channel_idx').on(table.channelId, table.kind),
]);

export type CommerceChannelKey = typeof commerceChannelKeys.$inferSelect;
export type NewCommerceChannelKey = typeof commerceChannelKeys.$inferInsert;
