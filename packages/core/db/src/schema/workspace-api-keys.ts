import { pgTable, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

// Workspace API keys - shared across workspace
export const workspaceApiKeys = pgTable(
  'workspace_api_keys',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    // Key info
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),

    // The actual key (hashed for storage, only shown once on creation)
    keyHash: varchar('key_hash', { length: 255 }).notNull(),

    // Key prefix for identification (e.g., "wsk_" + first 8 chars)
    keyPrefix: varchar('key_prefix', { length: 20 }).notNull(),

    // Who created this key
    createdBy: varchar('created_by', { length: 255 }).notNull(),

    // Scopes/permissions for this key
    scopes: jsonb('scopes').$type<string[]>().default([]),

    // Usage tracking
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),

    // Expiration (null = never expires)
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }), // Soft delete = revoked
  },
  (table) => [
    index('workspace_api_keys_key_prefix_idx').on(table.keyPrefix),
  ]
);

export type WorkspaceApiKey = typeof workspaceApiKeys.$inferSelect;
export type NewWorkspaceApiKey = typeof workspaceApiKeys.$inferInsert;
