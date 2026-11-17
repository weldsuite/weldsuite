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
 * wallet. See weldsuite-documentation/plans/weldpanel.md.
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
    /** Credits those blocks cost, as charged (the rate can change between months). */
    eventCreditsCharged: integer('event_credits_charged').notNull().default(0),
    recordingCreditsCharged: integer('recording_credits_charged').notNull().default(0),
    /**
     * Usage emails already sent this month, so each goes once: `80` and `100` (percent of an
     * allowance), `replay_blocked` and `events_blocked` (data is being dropped).
     */
    notified: jsonb('notified').$type<string[]>().notNull().default([]),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('panel_usage_monthly_workspace_month_idx').on(table.workspaceId, table.month)],
);

export const PANEL_DOMAIN_STATUSES = ['pending', 'active', 'failed', 'deleting'] as const;
export type PanelDomainStatus = (typeof PANEL_DOMAIN_STATUSES)[number];

/** A DNS record the customer adds to prove ownership or validate the certificate. */
export type PanelDomainVerificationRecord = { type: 'CNAME' | 'TXT'; name: string; value: string; purpose: 'routing' | 'ownership' | 'certificate' };

/**
 * A customer's own collector host name (`stats.example.com`), served through a
 * Cloudflare for SaaS custom hostname that points at panel-ingest, so ad
 * blockers that know the shared collector host don't drop the site's events.
 * Master DB: host names are unique across workspaces, and the cron that polls
 * Cloudflare for status reads every pending row without opening tenant DBs.
 */
export const panelCustomDomains = pgTable(
  'panel_custom_domains',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pncd_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    hostname: varchar('hostname', { length: 253 }).notNull(),
    /** Cloudflare's custom hostname id, once created. */
    cfCustomHostnameId: varchar('cf_custom_hostname_id', { length: 64 }),
    status: varchar('status', { length: 20 }).$type<PanelDomainStatus>().notNull().default('pending'),
    /** Cloudflare's certificate status, as reported (`pending_validation`, `active`, …). */
    sslStatus: varchar('ssl_status', { length: 40 }),
    verification: jsonb('verification').$type<PanelDomainVerificationRecord[]>().notNull().default([]),
    lastError: varchar('last_error', { length: 500 }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('panel_custom_domains_hostname_idx').on(table.hostname),
    index('panel_custom_domains_project_idx').on(table.workspaceId, table.projectId),
  ],
);

/**
 * Public share links (`/share/panel/<token>`): the token's SHA-256 → the
 * workspace and the tenant `panel_share_links` row, so the unauthenticated
 * route finds the tenant without trying every workspace.
 */
export const panelShareRegistry = pgTable(
  'panel_share_registry',
  {
    tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    /** The tenant `panel_share_links.id`. */
    linkId: varchar('link_id', { length: 30 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('panel_share_registry_link_idx').on(table.workspaceId, table.linkId)],
);

export const PANEL_SCHEDULE_KINDS = ['alert', 'subscription', 'export'] as const;
export type PanelScheduleKind = (typeof PANEL_SCHEDULE_KINDS)[number];

/**
 * When each alert, scheduled report and raw export is next due, across
 * workspaces: panel-api's cron reads the due rows here and opens only those
 * workspaces' tenant DBs (the DATA-009 pattern). The tenant row stays the
 * source of truth; panel-api writes this row whenever it changes.
 */
export const panelScheduleRegistry = pgTable(
  'panel_schedule_registry',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnsr_
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    kind: varchar('kind', { length: 20 }).$type<PanelScheduleKind>().notNull(),
    /** The tenant row (`panel_alerts.id`, `panel_subscriptions.id`, `panel_exports.id`). */
    objectId: varchar('object_id', { length: 30 }).notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    /** Set while a run holds the row, so two cron invocations don't both take it. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('panel_schedule_registry_object_idx').on(table.kind, table.objectId),
    index('panel_schedule_registry_due_idx').on(table.nextRunAt),
  ],
);

export type PanelCustomDomain = typeof panelCustomDomains.$inferSelect;
export type NewPanelCustomDomain = typeof panelCustomDomains.$inferInsert;
export type PanelShareRegistryRow = typeof panelShareRegistry.$inferSelect;
export type NewPanelShareRegistryRow = typeof panelShareRegistry.$inferInsert;
export type PanelScheduleRegistryRow = typeof panelScheduleRegistry.$inferSelect;
export type NewPanelScheduleRegistryRow = typeof panelScheduleRegistry.$inferInsert;
export type PanelProjectRegistryRow = typeof panelProjectRegistry.$inferSelect;
export type NewPanelProjectRegistryRow = typeof panelProjectRegistry.$inferInsert;
export type PanelKey = typeof panelKeyRegistry.$inferSelect;
export type NewPanelKey = typeof panelKeyRegistry.$inferInsert;
export type PanelUsageMonth = typeof panelUsageMonthly.$inferSelect;
export type NewPanelUsageMonth = typeof panelUsageMonthly.$inferInsert;
