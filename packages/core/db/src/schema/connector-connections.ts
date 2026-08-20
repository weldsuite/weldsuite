import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * First-party connector framework (WeldConnect).
 *
 * Credentials are stored here (encrypted JSONB) — we talk to each provider
 * ourselves. Replacing a provider later is a code change plus a credential
 * re-save, not a third-party host migration.
 *
 * `integration_entity_mappings` still maps synced records onto WeldSuite
 * entities, so an entity imported by a connector is deduped against the same
 * rows the legacy CRM adapters use.
 */

/** Lifecycle of a tenant's connection to a third-party app. */
export type ConnectorConnectionStatus =
  | 'pending'
  | 'active'
  /** Credentials rejected by the provider — the tenant must re-enter them. */
  | 'auth_error'
  /** Last sync failed; credentials are still good. */
  | 'sync_error'
  /** Syncs deliberately paused by the tenant. */
  | 'paused';

/** What kicked off a sync run. */
export type ConnectorSyncTrigger = 'webhook' | 'manual' | 'schedule' | 'initial';

/** Outcome of a single sync run. */
export type ConnectorSyncRunStatus = 'running' | 'success' | 'error' | 'partial';

/** Encrypted provider credentials. Keys match `ConnectorDef.auth.fields`. */
export type ConnectorCredentials = Record<string, string>;

export const connectorConnections = pgTable(
  'connector_connections',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    /** Catalog provider id, e.g. `woocommerce`. */
    provider: varchar('provider', { length: 100 }).notNull(),
    /** Tenant-facing label, defaults to the connector name. */
    displayName: varchar('display_name', { length: 255 }),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('pending')
      .$type<ConnectorConnectionStatus>(),

    /** Encrypted JSONB — never returned to the browser. */
    credentials: jsonb('credentials').$type<ConnectorCredentials>(),
    /** Provider account identity (WooCommerce store URL, …). */
    externalAccountId: varchar('external_account_id', { length: 255 }),

    /** Sync names / setting keys enabled for this connection. Null = every sync. */
    enabledSyncs: jsonb('enabled_syncs').$type<string[]>(),
    /** Per-model incremental watermark: model → ISO timestamp of the last ingest. */
    syncWatermarks: jsonb('sync_watermarks').$type<Record<string, string>>(),

    lastSyncAt: timestamp('last_sync_at'),
    lastSyncStatus: varchar('last_sync_status', { length: 20 }).$type<ConnectorSyncRunStatus>(),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at'),
    recordsSynced: integer('records_synced').notNull().default(0),

    connectedAt: timestamp('connected_at'),
    connectedBy: varchar('connected_by', { length: 255 }),
    disconnectedAt: timestamp('disconnected_at'),
  },
  (table) => [
    // One live connection per provider. Reconnecting reuses the row, which
    // keeps every `integration_entity_mappings` row pointing at it valid.
    uniqueIndex('connector_connections_provider_unique').on(table.provider),
    index('connector_connections_status_idx').on(table.status),
    index('connector_connections_deleted_at_idx').on(table.deletedAt),
  ],
);

/**
 * One row per sync run per model — the audit trail behind "sync health" in the
 * WeldConnect UI. Written by the sync runner (manual, scheduled, or webhook).
 */
export const connectorSyncRuns = pgTable(
  'connector_sync_runs',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    connectionId: varchar('connection_id', { length: 30 })
      .notNull()
      .references(() => connectorConnections.id, { onDelete: 'cascade' }),

    syncName: varchar('sync_name', { length: 100 }).notNull(),
    model: varchar('model', { length: 100 }).notNull(),

    status: varchar('status', { length: 20 }).notNull().default('running').$type<ConnectorSyncRunStatus>(),
    trigger: varchar('trigger', { length: 20 }).notNull().$type<ConnectorSyncTrigger>(),
    /** 'INCREMENTAL' | 'INITIAL' | 'FULL' | 'WEBHOOK'. */
    syncType: varchar('sync_type', { length: 20 }),

    recordsAdded: integer('records_added').notNull().default(0),
    recordsUpdated: integer('records_updated').notNull().default(0),
    recordsDeleted: integer('records_deleted').notNull().default(0),
    recordsCreated: integer('records_created').notNull().default(0),
    recordsModified: integer('records_modified').notNull().default(0),
    recordsSkipped: integer('records_skipped').notNull().default(0),
    recordsFailed: integer('records_failed').notNull().default(0),

    startedAt: timestamp('started_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
    durationMs: integer('duration_ms'),

    error: text('error'),
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
