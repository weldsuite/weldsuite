/**
 * WeldPanel — product analytics and session recordings. Tenant DB.
 *
 * Configuration and saved objects only. Tracked events, identity links,
 * profile snapshots and the recording chunk index live in Basin Iceberg
 * tables; profiles themselves live in a Durable Object per project; recording
 * chunks live in the private EU bucket. None of it is ever written here, so
 * website traffic never wakes a tenant database (ADR DATA-008).
 *
 * The collector finds a project by its public token through the master
 * `panel_project_registry` (weldpanel-registry.ts), which panel-api keeps in
 * step with `panel_projects`.
 *
 * See docs/plans/weldpanel.md.
 */

import { pgTable, varchar, text, timestamp, boolean, integer, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export const PANEL_PROJECT_KINDS = ['website', 'app'] as const;
export type PanelProjectKind = (typeof PANEL_PROJECT_KINDS)[number];

export const PANEL_PROJECT_STATUSES = ['active', 'paused'] as const;
export type PanelProjectStatus = (typeof PANEL_PROJECT_STATUSES)[number];

/** How much of the page a recording masks. Password fields are always masked. */
export const PANEL_MASKING_LEVELS = ['strict', 'balanced', 'relaxed'] as const;
export type PanelMaskingLevel = (typeof PANEL_MASKING_LEVELS)[number];

/**
 * `required`: cookieless counting until the site calls `consent.grant()`.
 * `none`: full tracking from the first page (sites that need no consent).
 */
export const PANEL_CONSENT_MODES = ['required', 'none'] as const;
export type PanelConsentMode = (typeof PANEL_CONSENT_MODES)[number];

export const PANEL_REPORT_KINDS = ['web', 'trends', 'funnel', 'retention', 'flows'] as const;
export type PanelReportKind = (typeof PANEL_REPORT_KINDS)[number];

export const PANEL_VISIBILITIES = ['private', 'workspace'] as const;
export type PanelVisibility = (typeof PANEL_VISIBILITIES)[number];

export const PANEL_DEFINITION_KINDS = ['event', 'property'] as const;
export type PanelDefinitionKind = (typeof PANEL_DEFINITION_KINDS)[number];

export const PANEL_SUMMARY_SCOPES = ['session', 'set'] as const;
export type PanelSummaryScope = (typeof PANEL_SUMMARY_SCOPES)[number];

/** Per-project collector and privacy settings. Copied into the master registry for the collector. */
export type PanelProjectSettings = {
  autocapture: boolean;
  maskingLevel: PanelMaskingLevel;
  consentMode: PanelConsentMode;
  /** Share of consented sessions that are recorded, 0–1. */
  recordingSampleRate: number;
  /** URL patterns (`/admin/*`) where nothing is collected. */
  excludedUrls: string[];
  /** IPs or CIDR ranges whose traffic is dropped (the team's own office). */
  ipFilters: string[];
  /** AI summaries may be generated for this project's recordings. */
  aiEnabled: boolean;
};

/** A dashboard tile's place on the grid, in grid units. */
export type PanelTileLayout = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const panelProjects = pgTable(
  'panel_projects',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnp_
    name: varchar('name', { length: 255 }).notNull(),
    kind: varchar('kind', { length: 20 }).$type<PanelProjectKind>().notNull().default('website'),
    status: varchar('status', { length: 20 }).$type<PanelProjectStatus>().notNull().default('active'),

    /** Public project token (`wpk_…`). Safe in page source: it can only send data. */
    token: varchar('token', { length: 64 }).notNull(),
    /** Hosts the collector accepts events from (subdomains included). Empty = any. */
    allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
    settings: jsonb('settings').$type<PanelProjectSettings>().notNull(),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('panel_projects_token_idx').on(table.token)],
);

/** A saved query. `spec` is the typed query spec panel-api compiles to SQL; clients never send SQL. */
export const panelReports = pgTable(
  'panel_reports',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnr_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    kind: varchar('kind', { length: 20 }).$type<PanelReportKind>().notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),

    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),
    visibility: varchar('visibility', { length: 20 }).$type<PanelVisibility>().notNull().default('private'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('panel_reports_project_idx').on(table.projectId),
    index('panel_reports_owner_idx').on(table.ownerUserId),
  ],
);

export const panelDashboards = pgTable(
  'panel_dashboards',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnd_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),

    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),
    visibility: varchar('visibility', { length: 20 }).$type<PanelVisibility>().notNull().default('private'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_dashboards_project_idx').on(table.projectId)],
);

export const panelDashboardTiles = pgTable(
  'panel_dashboard_tiles',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnt_
    dashboardId: varchar('dashboard_id', { length: 30 }).notNull(),
    reportId: varchar('report_id', { length: 30 }).notNull(),
    layout: jsonb('layout').$type<PanelTileLayout>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('panel_dashboard_tiles_dashboard_idx').on(table.dashboardId)],
);

/** A saved filter on tracked users, evaluated at query time. */
export const panelCohorts = pgTable(
  'panel_cohorts',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnc_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    filter: jsonb('filter').$type<Record<string, unknown>>().notNull(),

    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_cohorts_project_idx').on(table.projectId)],
);

/** Lexicon: what the team wrote about an event or property name seen in the data. */
export const panelEventDefinitions = pgTable(
  'panel_event_definitions',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pne_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    kind: varchar('kind', { length: 20 }).$type<PanelDefinitionKind>().notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    /** Left out of pickers and reports. The data stays. */
    hidden: boolean('hidden').notNull().default(false),
    verified: boolean('verified').notNull().default(false),

    updatedByUserId: varchar('updated_by_user_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('panel_event_definitions_name_idx').on(table.projectId, table.kind, table.name)],
);

/** A page group for heatmaps: every URL matching `urlPattern` (`/products/*`) counts as one page. */
export const panelHeatmapPages = pgTable(
  'panel_heatmap_pages',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnh_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    urlPattern: varchar('url_pattern', { length: 1000 }).notNull(),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('panel_heatmap_pages_project_idx').on(table.projectId)],
);

/** A favourited recording, kept for 13 months instead of the plan's recording retention. */
export const panelSessionFavorites = pgTable(
  'panel_session_favorites',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnf_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    /** Client-generated session id, as in the Basin tables. */
    sessionId: varchar('session_id', { length: 64 }).notNull(),
    note: text('note'),

    favoritedByUserId: varchar('favorited_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('panel_session_favorites_session_idx').on(table.projectId, table.sessionId)],
);

/** Cached AI summaries, so a recording or a set is summarised (and charged) once. */
export const panelAiSummaries = pgTable(
  'panel_ai_summaries',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pna_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    scope: varchar('scope', { length: 20 }).$type<PanelSummaryScope>().notNull(),
    /** Set for a `session` summary. */
    sessionId: varchar('session_id', { length: 64 }),
    /** Hash of the filter that picked the sessions, for a `set` summary. */
    filterHash: varchar('filter_hash', { length: 64 }),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),

    /** The model that served (AI-005). */
    modelId: varchar('model_id', { length: 100 }).notNull(),
    creditsCharged: integer('credits_charged').notNull().default(0),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('panel_ai_summaries_session_idx').on(table.projectId, table.sessionId),
    index('panel_ai_summaries_filter_idx').on(table.projectId, table.filterHash),
  ],
);

export type PanelProject = typeof panelProjects.$inferSelect;
export type NewPanelProject = typeof panelProjects.$inferInsert;
export type PanelReport = typeof panelReports.$inferSelect;
export type NewPanelReport = typeof panelReports.$inferInsert;
export type PanelDashboard = typeof panelDashboards.$inferSelect;
export type NewPanelDashboard = typeof panelDashboards.$inferInsert;
export type PanelDashboardTile = typeof panelDashboardTiles.$inferSelect;
export type NewPanelDashboardTile = typeof panelDashboardTiles.$inferInsert;
export type PanelCohort = typeof panelCohorts.$inferSelect;
export type NewPanelCohort = typeof panelCohorts.$inferInsert;
export type PanelEventDefinition = typeof panelEventDefinitions.$inferSelect;
export type NewPanelEventDefinition = typeof panelEventDefinitions.$inferInsert;
export type PanelHeatmapPage = typeof panelHeatmapPages.$inferSelect;
export type NewPanelHeatmapPage = typeof panelHeatmapPages.$inferInsert;
export type PanelSessionFavorite = typeof panelSessionFavorites.$inferSelect;
export type NewPanelSessionFavorite = typeof panelSessionFavorites.$inferInsert;
export type PanelAiSummary = typeof panelAiSummaries.$inferSelect;
export type NewPanelAiSummary = typeof panelAiSummaries.$inferInsert;
