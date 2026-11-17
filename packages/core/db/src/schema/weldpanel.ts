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
 * See weldsuite-documentation/plans/weldpanel.md.
 */

import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  doublePrecision,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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

export const PANEL_REPORT_KINDS = ['web', 'trends', 'funnel', 'retention', 'flows', 'stickiness', 'lifecycle', 'vitals', 'impact', 'signal'] as const;
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

/** `report` shows a saved report; `text` shows the tile's own Markdown. */
export const PANEL_TILE_KINDS = ['report', 'text'] as const;
export type PanelTileKind = (typeof PANEL_TILE_KINDS)[number];

/**
 * Dashboard-wide overrides applied to every report tile: a date range and
 * filters ANDed onto each report's own. Shapes are the query spec's
 * (`@weldsuite/app-api-client/schemas/weldpanel-query`); stored as JSON here.
 */
export type PanelDashboardFilters = {
  dateRange?: Record<string, unknown>;
  filters?: Record<string, unknown>[];
};

/** What a comment, share link or subscription is attached to. */
export const PANEL_TARGET_TYPES = ['report', 'dashboard'] as const;
export type PanelTargetType = (typeof PANEL_TARGET_TYPES)[number];

export const PANEL_ALERT_STATES = ['pending', 'ok', 'firing', 'error'] as const;
export type PanelAlertState = (typeof PANEL_ALERT_STATES)[number];

export const PANEL_ALERT_EVENT_KINDS = ['fired', 'resolved', 'error'] as const;
export type PanelAlertEventKind = (typeof PANEL_ALERT_EVENT_KINDS)[number];

export const PANEL_CHECK_INTERVALS = ['hourly', 'daily', 'weekly'] as const;
export type PanelCheckInterval = (typeof PANEL_CHECK_INTERVALS)[number];

/**
 * Where an alert or a scheduled report is delivered. Secrets (a Slack webhook
 * URL) are never kept here: they sit encrypted in the row's own column.
 */
export type PanelDeliveryChannels = {
  /** Workspace members (user ids) who get an email. */
  emailUserIds: string[];
  /** In-app notification to the same members and the owner. */
  inApp: boolean;
  /** A Slack incoming webhook is set (the URL is in `slack_webhook_ciphertext`). */
  slack: boolean;
  /** WeldChat channel to post into, when set. */
  weldchatChannelId?: string | null;
};

export const PANEL_EXPORT_STATUSES = ['active', 'paused', 'failing'] as const;
export type PanelExportStatus = (typeof PANEL_EXPORT_STATUSES)[number];

export const PANEL_EXPORT_FREQUENCIES = ['hourly', 'daily'] as const;
export type PanelExportFrequency = (typeof PANEL_EXPORT_FREQUENCIES)[number];

export const PANEL_EXPORT_TABLES = ['events', 'people', 'groups', 'identities'] as const;
export type PanelExportTable = (typeof PANEL_EXPORT_TABLES)[number];

/** Where a raw export writes (any S3-compatible API). The secret key is encrypted in `secret_ciphertext`. */
export type PanelExportDestination = {
  provider: 's3' | 'r2' | 'gcs' | 'minio' | 'other';
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  /** Path-style addressing (`endpoint/bucket/key`), for MinIO and most self-hosted stores. */
  pathStyle: boolean;
};

export const PANEL_EXPORT_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type PanelExportRunStatus = (typeof PANEL_EXPORT_RUN_STATUSES)[number];

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
    /** Date range and filters applied to every report tile; null = each report as saved. */
    filters: jsonb('filters').$type<PanelDashboardFilters>(),
    /** The built-in template it was created from, if any (`website-overview`, …). */
    template: varchar('template', { length: 50 }),

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
    kind: varchar('kind', { length: 20 }).$type<PanelTileKind>().notNull().default('report'),
    /** Set for a `report` tile. */
    reportId: varchar('report_id', { length: 30 }),
    /** Markdown of a `text` tile. */
    text: text('text'),
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

// ---------------------------------------------------------------------------
// Data definitions: custom events, computed properties, path rules, group types
// ---------------------------------------------------------------------------

/**
 * A custom event (Mixpanel's "custom event", PostHog's "action"): one name for
 * several events, each with its own filters. Query specs refer to it as
 * `@<id>` wherever they take an event name; it is expanded at compile time.
 */
export const panelCustomEvents = pgTable(
  'panel_custom_events',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnce_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    /** `{ match: [{ event, filters }] }`, validated by the shared Zod schema. */
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),

    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_custom_events_project_idx').on(table.projectId)],
);

/**
 * A computed property: a value derived from event properties at query time (a
 * formula over numeric properties, or the first property that is set). Query
 * specs refer to it as `@<id>` wherever they take an event property key.
 */
export const panelComputedProperties = pgTable(
  'panel_computed_properties',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pncp_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    /** `{ kind: 'formula', expression } | { kind: 'coalesce', keys }`, validated by the shared Zod schema. */
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),

    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_computed_properties_project_idx').on(table.projectId)],
);

/**
 * Path cleaning: a regular expression on the URL path and its replacement
 * (`/users/\d+` → `/users/:id`), applied in order wherever reports group by
 * path (top pages, entry and exit pages, flows, path breakdowns).
 */
export const panelPathRules = pgTable(
  'panel_path_rules',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnpr_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    position: integer('position').notNull(),
    pattern: varchar('pattern', { length: 500 }).notNull(),
    replacement: varchar('replacement', { length: 500 }).notNull(),
    description: text('description'),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('panel_path_rules_project_idx').on(table.projectId, table.position)],
);

/**
 * A group type for group analytics (`company`, `workspace`): what the SDK's
 * `group(type, key)` sends as the `$group_<type>` event property. At most five
 * per project. Group profiles themselves live in the PanelProject object and
 * the Basin `groups_v1` table, like people.
 */
export const panelGroupTypes = pgTable(
  'panel_group_types',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pngt_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    groupType: varchar('group_type', { length: 32 }).notNull(),
    nameSingular: varchar('name_singular', { length: 100 }).notNull(),
    namePlural: varchar('name_plural', { length: 100 }).notNull(),
    /** Group property matched against WeldCRM companies (`domain` or `name`); null = no CRM link. */
    crmMatchProperty: varchar('crm_match_property', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('panel_group_types_type_idx').on(table.projectId, table.groupType)],
);

// ---------------------------------------------------------------------------
// Collaboration: annotations, comments, report versions, metric trees, share links
// ---------------------------------------------------------------------------

/** A note pinned to a moment on time-series charts: the whole project, or one report. */
export const panelAnnotations = pgTable(
  'panel_annotations',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnan_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    /** Null = shown on every chart of the project. */
    reportId: varchar('report_id', { length: 30 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    label: varchar('label', { length: 200 }).notNull(),
    description: text('description'),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_annotations_project_idx').on(table.projectId, table.occurredAt)],
);

export const panelComments = pgTable(
  'panel_comments',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pncm_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    targetType: varchar('target_type', { length: 20 }).$type<PanelTargetType>().notNull(),
    targetId: varchar('target_id', { length: 30 }).notNull(),
    body: text('body').notNull(),

    authorUserId: varchar('author_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_comments_target_idx').on(table.targetType, table.targetId)],
);

/** The state of a report before each change, so an earlier version can be seen and restored. */
export const panelReportVersions = pgTable(
  'panel_report_versions',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnrv_
    reportId: varchar('report_id', { length: 30 }).notNull(),
    version: integer('version').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('panel_report_versions_report_idx').on(table.reportId, table.version)],
);

/**
 * A metric tree: an output metric and the input metrics that drive it, each
 * node a single-series trends spec or a saved report. `nodes` is validated by
 * the shared Zod schema.
 */
export const panelMetricTrees = pgTable(
  'panel_metric_trees',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnmt_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    nodes: jsonb('nodes').$type<Record<string, unknown>[]>().notNull(),

    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),
    visibility: varchar('visibility', { length: 20 }).$type<PanelVisibility>().notNull().default('private'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_metric_trees_project_idx').on(table.projectId)],
);

/**
 * A public link to a report or dashboard: anyone with the link sees the
 * aggregated results, never people, recordings or raw events. Only the SHA-256
 * of the token is kept (here and in the master `panel_share_registry`, which
 * the public route reads to find the workspace).
 */
export const panelShareLinks = pgTable(
  'panel_share_links',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnsl_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    targetType: varchar('target_type', { length: 20 }).$type<PanelTargetType>().notNull(),
    targetId: varchar('target_id', { length: 30 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** The token's first characters, to tell links apart in the list. */
    tokenPrefix: varchar('token_prefix', { length: 16 }).notNull(),
    /** The page may be shown in an iframe on other sites. */
    allowEmbed: boolean('allow_embed').notNull().default(false),
    /** Viewers may pick another date preset (within the plan's retention). */
    allowDateChange: boolean('allow_date_change').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('panel_share_links_token_idx').on(table.tokenHash),
    index('panel_share_links_target_idx').on(table.targetType, table.targetId),
  ],
);

// ---------------------------------------------------------------------------
// Monitoring: alerts and scheduled reports
// ---------------------------------------------------------------------------

/**
 * An alert on one series of a trends query: a threshold, a change against the
 * previous interval, or an anomaly against the recent baseline. Checked by
 * panel-api's cron through the master `panel_schedule_registry`.
 */
export const panelAlerts = pgTable(
  'panel_alerts',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnal_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    /** The saved trends report it watches, or null when `spec` is its own. */
    reportId: varchar('report_id', { length: 30 }),
    /** A trends query spec (when `reportId` is null), validated by the shared Zod schema. */
    spec: jsonb('spec').$type<Record<string, unknown>>(),
    seriesIndex: integer('series_index').notNull().default(0),
    /** `{ type: 'threshold' | 'change' | 'anomaly', … }`, validated by the shared Zod schema. */
    condition: jsonb('condition').$type<Record<string, unknown>>().notNull(),
    checkInterval: varchar('check_interval', { length: 20 }).$type<PanelCheckInterval>().notNull().default('daily'),
    channels: jsonb('channels').$type<PanelDeliveryChannels>().notNull(),
    /** Encrypted Slack incoming-webhook URL. */
    slackWebhookCiphertext: text('slack_webhook_ciphertext'),
    enabled: boolean('enabled').notNull().default(true),

    state: varchar('state', { length: 20 }).$type<PanelAlertState>().notNull().default('pending'),
    lastValue: doublePrecision('last_value'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    lastError: text('last_error'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),

    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_alerts_project_idx').on(table.projectId)],
);

/** History of an alert: when it fired, resolved or could not be checked. */
export const panelAlertEvents = pgTable(
  'panel_alert_events',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnae_
    alertId: varchar('alert_id', { length: 30 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    kind: varchar('kind', { length: 20 }).$type<PanelAlertEventKind>().notNull(),
    value: doublePrecision('value'),
    /** The bound the value crossed (threshold, or the anomaly band edge). */
    bound: doublePrecision('bound'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('panel_alert_events_alert_idx').on(table.alertId, table.createdAt)],
);

/** A report or dashboard sent on a schedule by email, in-app, Slack or WeldChat. */
export const panelSubscriptions = pgTable(
  'panel_subscriptions',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnsb_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    targetType: varchar('target_type', { length: 20 }).$type<PanelTargetType>().notNull(),
    targetId: varchar('target_id', { length: 30 }).notNull(),
    /** `{ frequency, hour, weekday?, monthDay?, timezone }`, validated by the shared Zod schema. */
    schedule: jsonb('schedule').$type<Record<string, unknown>>().notNull(),
    channels: jsonb('channels').$type<PanelDeliveryChannels>().notNull(),
    slackWebhookCiphertext: text('slack_webhook_ciphertext'),
    enabled: boolean('enabled').notNull().default(true),

    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastError: text('last_error'),

    ownerUserId: varchar('owner_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('panel_subscriptions_project_idx').on(table.projectId),
    index('panel_subscriptions_target_idx').on(table.targetType, table.targetId),
  ],
);

// ---------------------------------------------------------------------------
// Data out: raw exports to S3-compatible storage
// ---------------------------------------------------------------------------

/**
 * A raw export of a project's tables to the customer's S3-compatible bucket as
 * gzipped JSON Lines, hourly or daily. `exportedUntil` is the cursor: every
 * row received before it has been written.
 */
export const panelExports = pgTable(
  'panel_exports',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pnex_
    projectId: varchar('project_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    destination: jsonb('destination').$type<PanelExportDestination>().notNull(),
    /** Encrypted secret access key. */
    secretCiphertext: text('secret_ciphertext').notNull(),
    tables: jsonb('tables').$type<PanelExportTable[]>().notNull(),
    frequency: varchar('frequency', { length: 20 }).$type<PanelExportFrequency>().notNull().default('daily'),
    /** Backfill from here (at most the project's retention back). */
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    exportedUntil: timestamp('exported_until', { withTimezone: true }),
    status: varchar('status', { length: 20 }).$type<PanelExportStatus>().notNull().default('active'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastError: text('last_error'),

    createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('panel_exports_project_idx').on(table.projectId)],
);

export const panelExportRuns = pgTable(
  'panel_export_runs',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // pner_
    exportId: varchar('export_id', { length: 30 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    table: varchar('table_name', { length: 20 }).$type<PanelExportTable>().notNull(),
    windowFrom: timestamp('window_from', { withTimezone: true }).notNull(),
    windowTo: timestamp('window_to', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 20 }).$type<PanelExportRunStatus>().notNull().default('running'),
    rows: integer('rows').notNull().default(0),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    files: integer('files').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('panel_export_runs_export_idx').on(table.exportId, table.startedAt)],
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
export type PanelCustomEvent = typeof panelCustomEvents.$inferSelect;
export type NewPanelCustomEvent = typeof panelCustomEvents.$inferInsert;
export type PanelComputedProperty = typeof panelComputedProperties.$inferSelect;
export type NewPanelComputedProperty = typeof panelComputedProperties.$inferInsert;
export type PanelPathRule = typeof panelPathRules.$inferSelect;
export type NewPanelPathRule = typeof panelPathRules.$inferInsert;
export type PanelGroupType = typeof panelGroupTypes.$inferSelect;
export type NewPanelGroupType = typeof panelGroupTypes.$inferInsert;
export type PanelAnnotation = typeof panelAnnotations.$inferSelect;
export type NewPanelAnnotation = typeof panelAnnotations.$inferInsert;
export type PanelComment = typeof panelComments.$inferSelect;
export type NewPanelComment = typeof panelComments.$inferInsert;
export type PanelReportVersion = typeof panelReportVersions.$inferSelect;
export type NewPanelReportVersion = typeof panelReportVersions.$inferInsert;
export type PanelMetricTree = typeof panelMetricTrees.$inferSelect;
export type NewPanelMetricTree = typeof panelMetricTrees.$inferInsert;
export type PanelShareLink = typeof panelShareLinks.$inferSelect;
export type NewPanelShareLink = typeof panelShareLinks.$inferInsert;
export type PanelAlert = typeof panelAlerts.$inferSelect;
export type NewPanelAlert = typeof panelAlerts.$inferInsert;
export type PanelAlertEvent = typeof panelAlertEvents.$inferSelect;
export type NewPanelAlertEvent = typeof panelAlertEvents.$inferInsert;
export type PanelSubscription = typeof panelSubscriptions.$inferSelect;
export type NewPanelSubscription = typeof panelSubscriptions.$inferInsert;
export type PanelExport = typeof panelExports.$inferSelect;
export type NewPanelExport = typeof panelExports.$inferInsert;
export type PanelExportRun = typeof panelExportRuns.$inferSelect;
export type NewPanelExportRun = typeof panelExportRuns.$inferInsert;
