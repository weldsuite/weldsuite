/**
 * WeldPanel registries and usage. Master DB.
 *
 * The public collector (apps/workers/panel-ingest) never opens a tenant
 * database (ADR DATA-008). It finds a project from the token in the request
 * through `panel_project_registry`, cached in KV, and a server-side caller
 * through the SHA-256 of its secret key in `panel_key_registry`. The tenant
 * `panel_projects` row stays the source of truth; panel-api writes the
 * registry row whenever the project changes.
 *
 * `panel_usage_monthly` is where the PanelUsage Durable Object flushes a
 * workspace's counts and records the overage blocks it charged to the credit
 * wallet. See docs/plans/weldpanel.md.
 */

import { pgTable, varchar, timestamp, integer, bigint, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PanelProjectSettings, PanelProjectStatus } from './weldpanel';

export const panelProjectRegistry = pgTable(
  'panel_project_registry',
  {
    /** The tenant `panel_projects.id`. */
    projectId: varchar('project_id', { length: 30 }).primaryKey(),
    /** Public project token (`wpk_…`). */
    token: varchar('token', { length: 64 }).notNull(),
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    status: varchar('status', { length: 20 }).$type<PanelProjectStatus>().notNull(),
    /** Copy of the tenant row's collector settings and allowed domains. */
    allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
    settings: jsonb('settings').$type<PanelProjectSettings>().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Project deleted: the collector drops its traffic. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('panel_project_registry_token_idx').on(table.token),
    index('panel_project_registry_workspace_idx').on(table.workspaceId),
  ],
);

/** Secret keys (`wps_…`) for server-side ingest and imports. Only the SHA-256 is stored. */
export const panelKeyRegistry = pgTable(
  'panel_key_registry',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnk_
    /** SHA-256 (hex) of the key. */
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    /** First characters of the key, shown in the UI to tell keys apart. */
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('panel_key_registry_hash_idx').on(table.keyHash),
    index('panel_key_registry_project_idx').on(table.workspaceId, table.projectId),
  ],
);

export const panelUsageMonthly = pgTable(
  'panel_usage_monthly',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnu_
    /** Master `workspaces.id`. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    /** Calendar month, UTC, `YYYY-MM`. */
    month: varchar('month', { length: 7 }).notNull(),
    events: bigint('events', { mode: 'number' }).notNull().default(0),
    recordings: integer('recordings').notNull().default(0),
    /** Overage blocks already charged to the wallet (10,000 events / 100 recordings each). */
    eventBlocksCharged: integer('event_blocks_charged').notNull().default(0),
    recordingBlocksCharged: integer('recording_blocks_charged').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('panel_usage_monthly_workspace_month_idx').on(table.workspaceId, table.month)],
);

export type PanelProjectRegistryRow = typeof panelProjectRegistry.$inferSelect;
export type NewPanelProjectRegistryRow = typeof panelProjectRegistry.$inferInsert;
export type PanelKey = typeof panelKeyRegistry.$inferSelect;
export type NewPanelKey = typeof panelKeyRegistry.$inferInsert;
export type PanelUsageMonth = typeof panelUsageMonthly.$inferSelect;
export type NewPanelUsageMonth = typeof panelUsageMonthly.$inferInsert;
