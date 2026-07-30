import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { OAuthTokens } from './integration-connections';

/**
 * WeldConnect connector framework.
 *
 * One table for every connector WeldSuite ships, whoever wrote it. Credentials
 * live here — encrypted via `lib/crypto` — because the framework owns the OAuth
 * flow and the refresh path rather than delegating them to a third party.
 *
 * Kept separate from `integration_connections` for now: that table also backs
 * MCP server connections and helpdesk channels, so it cannot be reshaped around
 * connector concerns without dragging those along. Folding the two together is
 * tracked as its own piece of work.
 *
 * Tenant isolation is the tenant database. Nothing here carries a workspace id,
 * so there is no code path that could address another tenant's connections.
 *
 * This file is the source of truth for the connector vocabulary — auth modes,
 * statuses, and the entity union. `@weldsuite/connectors` re-exports these
 * rather than declaring its own copies, because the database is what actually
 * constrains them and a second definition would drift.
 */

/** How a connection authenticates against the provider. */
export type ConnectorAuthMode =
  /** Authorization-code flow; tokens refresh on our side. */
  | 'oauth2'
  /** A long-lived token the tenant pasted in. No refresh path. */
  | 'api_token';

/** Lifecycle of a tenant's connection to a third-party app. */
export type ConnectorConnectionStatus =
  /** Connect flow started, waiting for the provider callback. */
  | 'pending'
  | 'active'
  /** Credentials rejected by the provider — the tenant must reauthorise. */
  | 'auth_error'
  /** Last sync failed; credentials are still good. */
  | 'sync_error'
  /** Syncs deliberately paused by the tenant. */
  | 'paused';

/** What kicked off a sync run. */
export type ConnectorSyncTrigger = 'webhook' | 'manual' | 'schedule' | 'initial';

/** Outcome of a single sync run. */
export type ConnectorSyncRunStatus = 'running' | 'success' | 'error' | 'partial';

/**
 * The one entity vocabulary every connector speaks.
 *
 * Replaces two competing sets that described the same things — the CRM sync
 * engine's `contact`/`customer` and the older provider layer's
 * `person`/`company`. These names win because they match WeldSuite's own entity
 * names, so the schema and the driver agree.
 */
export type SyncEntityType =
  // CRM
  | 'contact'
  | 'customer'
  | 'lead'
  | 'opportunity'
  | 'activity'
  | 'pipeline'
  // Calendar
  | 'calendar_event'
  // Accounting
  | 'invoice'
  | 'purchase_invoice'
  | 'ledger_account'
  | 'tax_rate'
  | 'payment';

export const connectorConnections = pgTable(
  'connector_connections',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    /** Catalog id and driver registry key (`moneybird`, `hubspot`, …). */
    connectorId: varchar('connector_id', { length: 100 }).notNull(),
    authMode: varchar('auth_mode', { length: 20 }).notNull().default('oauth2').$type<ConnectorAuthMode>(),

    /** Tenant-facing label, defaults to the connector name. */
    displayName: varchar('display_name', { length: 255 }),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('pending')
      .$type<ConnectorConnectionStatus>(),

    /**
     * Provider credentials, encrypted at rest via `lib/crypto`.
     *
     * Never select this column into anything that reaches a client. The routes
     * project an explicit column list for exactly this reason.
     */
    oauthTokens: jsonb('oauth_tokens').$type<OAuthTokens>(),

    /**
     * Refresh lease. Held briefly while one worker refreshes the access token so
     * concurrent sync messages do not each present the same rotating refresh
     * token — the second call would otherwise be rejected and the connection
     * flagged `auth_error` with nothing actually wrong.
     */
    refreshLockUntil: timestamp('refresh_lock_until'),

    /** Scopes actually granted, as reported at connect time. */
    scopes: jsonb('scopes').$type<string[]>(),
    /** Provider account identity (Moneybird administration id, HubSpot portal id, …). */
    externalAccountId: varchar('external_account_id', { length: 255 }),
    /** Per-connection driver settings. Passed through as `DriverContext.settings`. */
    settings: jsonb('settings').$type<Record<string, unknown>>(),

    /** Entities enabled for this connection. Null = every entity the connector declares. */
    enabledEntities: jsonb('enabled_entities').$type<SyncEntityType[]>(),
    /** Per-entity incremental watermark: entity type → ISO timestamp of the last ingest. */
    syncWatermarks: jsonb('sync_watermarks').$type<Record<string, string>>(),
    /** Tenant override for the catalog's default sweep interval. */
    syncIntervalHours: integer('sync_interval_hours'),

    /** Webhook registered at the provider, so it can be torn down on disconnect. */
    webhookId: varchar('webhook_id', { length: 255 }),
    /** Signing secret for inbound webhooks. Encrypted at rest. */
    webhookSecret: text('webhook_secret'),

    // Observability — surfaced in the UI so support never needs the database.
    lastSyncAt: timestamp('last_sync_at'),
    lastSyncStatus: varchar('last_sync_status', { length: 20 }).$type<ConnectorSyncRunStatus>(),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at'),
    recordsSynced: integer('records_synced').notNull().default(0),

    // Audit
    connectedAt: timestamp('connected_at'),
    connectedBy: varchar('connected_by', { length: 255 }),
    disconnectedAt: timestamp('disconnected_at'),
  },
  (table) => [
    // A tenant connects a given connector once. Reconnecting reuses the row,
    // which keeps every `integration_entity_mappings` row pointing at it valid
    // and turns a reauthorisation into an update rather than a duplicate import.
    uniqueIndex('connector_connections_connector_id_unique').on(table.connectorId),
    index('connector_connections_status_idx').on(table.status),
    index('connector_connections_deleted_at_idx').on(table.deletedAt),
    index('connector_connections_external_account_idx').on(table.externalAccountId),
  ],
);

/**
 * One row per sync run per entity — the audit trail behind "sync health" in the
 * WeldConnect UI. Written by the scheduler, the webhook ingest, and manual runs.
 */
export const connectorSyncRuns = pgTable(
  'connector_sync_runs',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    /**
     * Cascades: a connection that is genuinely gone leaves no orphan audit rows.
     * Disconnecting is a soft delete, so run history survives that.
     */
    connectionId: varchar('connection_id', { length: 30 })
      .notNull()
      .references(() => connectorConnections.id, { onDelete: 'cascade' }),

    entityType: varchar('entity_type', { length: 50 }).notNull().$type<SyncEntityType>(),

    status: varchar('status', { length: 20 })
      .notNull()
      .default('running')
      .$type<ConnectorSyncRunStatus>(),
    trigger: varchar('trigger', { length: 20 }).notNull().$type<ConnectorSyncTrigger>(),

    // What the ingest actually did.
    recordsCreated: integer('records_created').notNull().default(0),
    recordsModified: integer('records_modified').notNull().default(0),
    recordsSkipped: integer('records_skipped').notNull().default(0),
    recordsDeleted: integer('records_deleted').notNull().default(0),
    recordsFailed: integer('records_failed').notNull().default(0),
    /**
     * Pages read before the run stopped. A run that hits the page ceiling is not
     * a failure but it did not finish either, and this is how that shows up
     * without reading logs.
     */
    pagesRead: integer('pages_read').notNull().default(0),
    /** True when the run stopped at the page ceiling with more data waiting. */
    truncated: boolean('truncated').notNull().default(false),

    startedAt: timestamp('started_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
    durationMs: integer('duration_ms'),

    error: text('error'),
    /** First few per-record failures, so support can see the shape of a bad import. */
    errorSamples: jsonb('error_samples').$type<Array<{ externalId: string; message: string }>>(),
  },
  (table) => [
    index('connector_sync_runs_connection_idx').on(table.connectionId, table.createdAt),
    index('connector_sync_runs_status_idx').on(table.status),
  ],
);

export type ConnectorConnection = typeof connectorConnections.$inferSelect;
export type NewConnectorConnection = typeof connectorConnections.$inferInsert;
export type ConnectorSyncRun = typeof connectorSyncRuns.$inferSelect;
export type NewConnectorSyncRun = typeof connectorSyncRuns.$inferInsert;
