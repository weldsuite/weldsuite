/**
 * WeldCommerce registries. Master DB.
 *
 * The storefront API and the Mollie webhook run without a WeldSuite session, so
 * neither can open a tenant database before they know which one. A storefront key
 * (ADR COM-011) and a payment connection id (ADR COM-013) are resolved here to a
 * workspace; the tenant rows (`commerce_channel_keys`, `commerce_payment_connections`)
 * stay the source of truth and the commerce module writes the registry row in the
 * same step. Precedent: `widget_registry`, `workflow_webhook_registry`, `panel_key_registry`.
 */

import { pgTable, varchar, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

export type StorefrontKeyRegistryKind = 'publishable' | 'private';

export const storefrontKeyRegistry = pgTable(
  'storefront_key_registry',
  {
    /** The tenant `commerce_channel_keys.id`. */
    id: varchar('id', { length: 30 }).primaryKey(),
    /** SHA-256 (hex) of the key; the key itself is never stored. */
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    /** 'publishable' (`wcp_`) | 'private' (`wcs_`). */
    kind: varchar('kind', { length: 12 }).$type<StorefrontKeyRegistryKind>().notNull(),
    /** First characters of the key, shown to tell keys apart. */
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    /** `workspaces.id` (`ws_...`, ADR SEC-011), never the Clerk org id. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    /** The tenant `commerce_channels.id` the key belongs to. */
    channelId: varchar('channel_id', { length: 30 }).notNull(),
    /** Publishable keys only work from these origins; private keys ignore them. */
    allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default([]),
    /** The key this one replaced when rotated. */
    rotatedFromId: varchar('rotated_from_id', { length: 30 }),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at'),
    /** A revoked key stays so a replayed key is refused, not unknown. */
    revokedAt: timestamp('revoked_at'),
  },
  (table) => [
    uniqueIndex('storefront_key_registry_hash_idx').on(table.keyHash),
    index('storefront_key_registry_workspace_channel_idx').on(table.workspaceId, table.channelId),
  ],
);

export type StorefrontKeyRegistryRow = typeof storefrontKeyRegistry.$inferSelect;
export type NewStorefrontKeyRegistryRow = typeof storefrontKeyRegistry.$inferInsert;

/**
 * Payment connection id → workspace, for `/webhooks/commerce/:provider/:connectionId`.
 * `id` is the tenant `commerce_payment_connections.id` (unguessable, generated like
 * every id); the webhook trusts nothing it carries and reads the payment back from
 * the provider with the connection's own credentials.
 */
export const commerceConnectionRegistry = pgTable(
  'commerce_connection_registry',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    /** `workspaces.id` (`ws_...`, ADR SEC-011). */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    provider: varchar('provider', { length: 30 }).notNull().default('mollie'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    /** Set when the connection is removed; a late webhook then resolves to "gone". */
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [index('commerce_connection_registry_workspace_idx').on(table.workspaceId)],
);

export type CommerceConnectionRegistryRow = typeof commerceConnectionRegistry.$inferSelect;
export type NewCommerceConnectionRegistryRow = typeof commerceConnectionRegistry.$inferInsert;
