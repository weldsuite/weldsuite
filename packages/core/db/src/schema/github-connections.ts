import {
  pgTable,
  varchar,
  text,
  timestamp,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * GitHub App installation status
 */
export type GithubConnectionStatus = 'active' | 'suspended' | 'revoked';

/**
 * GitHub owner type
 */
export type GithubOwnerType = 'user' | 'org';

/**
 * GitHub App connections — one row per workspace installation.
 * Uses the GitHub App model: the installation token is derived from
 * the App private key (stored in Cloudflare Worker secrets) and
 * the installationId stored here.
 *
 * workspaceId is included for belt-and-suspenders tenant scoping even
 * though each workspace lives in its own database.
 */
export const githubConnections = pgTable(
  'github_connections',
  {
    // Base entity fields
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    // Tenant scope (belt-and-suspenders). Holds the Clerk org id (org_… ≈ 31-32
    // chars), so it must be wider than the 30-char generateId() ids.
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

    // GitHub App installation details
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    appSlug: text('app_slug').notNull(),

    // Account that installed the App
    ownerType: text('owner_type').notNull().$type<GithubOwnerType>(),
    ownerLogin: text('owner_login').notNull(),

    // Webhook secret for this installation (encrypted at rest via DB encryption key)
    webhookSecret: text('webhook_secret'),

    // Who connected the integration (Clerk user id, user_… ≈ 32 chars).
    createdBy: varchar('created_by', { length: 255 }),

    // Connection lifecycle
    status: text('status')
      .notNull()
      .default('active')
      .$type<GithubConnectionStatus>(),

    // OAuth scopes granted
    scopes: jsonb('scopes').$type<string[]>(),

    // Timestamps for lifecycle events
    installedAt: timestamp('installed_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (table) => [
    index('github_connections_workspace_id_idx').on(table.workspaceId),
    uniqueIndex('github_connections_installation_id_unique').on(table.installationId),
  ]
);

export type GithubConnection = typeof githubConnections.$inferSelect;
export type NewGithubConnection = typeof githubConnections.$inferInsert;
