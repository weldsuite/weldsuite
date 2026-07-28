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
 * Nango-backed connector framework (WeldConnect).
 *
 * Deliberately separate from `integration_connections`: that table stores OAuth
 * tokens we obtained and refresh ourselves. Under Nango the credentials live in
 * Nango and are addressed by `(providerConfigKey, nangoConnectionId)` — there is
 * no token column here, and there must never be one. Per-tenant isolation is
 * the tenant database plus the Nango `organization.id` we stamp at connect time.
 *
 * Credentials stay exportable from Nango, so replacing the provider later is a
 * config change rather than a re-authorisation of every customer.
 */

/** Lifecycle of a tenant's connection to a third-party app. */
export type NangoConnectionStatus =
  /** Connect session created, waiting for the auth webhook. */
  | 'pending'
  | 'active'
  /** Credentials rejected by the provider — the tenant must reauthorise. */
  | 'auth_error'
  /** Last sync failed; credentials are still good. */
  | 'sync_error'
  /** Syncs deliberately paused by the tenant. */
  | 'paused';

/** What kicked off a sync run. */
export type NangoSyncTrigger = 'webhook' | 'manual' | 'schedule' | 'initial';

/** Outcome of a single sync run. */
export type NangoSyncRunStatus = 'running' | 'success' | 'error' | 'partial';

export const nangoConnections = pgTable(
  'nango_connections',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),

    /** Nango integration unique key — matches `ConnectorDef.providerConfigKey`. */
    providerConfigKey: varchar('provider_config_key', { length: 100 }).notNull(),
    /** Underlying Nango provider slug (salesforce, hubspot, …). */
    provider: varchar('provider', { length: 100 }).notNull(),
    /** Connection id inside Nango. Null until the auth webhook lands. */
    nangoConnectionId: varchar('nango_connection_id', { length: 255 }),

    /** Tenant-facing label, defaults to the connector name. */
    displayName: varchar('display_name', { length: 255 }),
    status: varchar('status', { length: 20 })
      .notNull()
      .default('pending')
      .$type<NangoConnectionStatus>(),

    /** Scopes actually granted, as reported by Nango at connect time. */
    scopes: jsonb('scopes').$type<string[]>(),
    /** Provider account identity (Salesforce org id, HubSpot portal id, …). */
    externalAccountId: varchar('external_account_id', { length: 255 }),

    /** Sync names enabled for this connection. Null = every sync the connector declares. */
    enabledSyncs: jsonb('enabled_syncs').$type<string[]>(),
    /** Per-model incremental watermark: model → ISO timestamp of the last ingest. */
    syncWatermarks: jsonb('sync_watermarks').$type<Record<string, string>>(),

    // Observability — surfaced in the UI so support never needs the database.
    lastSyncAt: timestamp('last_sync_at'),
    lastSyncStatus: varchar('last_sync_status', { length: 20 }).$type<NangoSyncRunStatus>(),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at'),
    recordsSynced: integer('records_synced').notNull().default(0),

    // Audit
    connectedAt: timestamp('connected_at'),
    connectedBy: varchar('connected_by', { length: 255 }),
    disconnectedAt: timestamp('disconnected_at'),
  },
  (table) => [
    // A tenant connects a given integration once. Reconnecting reuses the row,
    // which keeps every `integration_entity_mappings` row pointing at it valid.
    uniqueIndex('nango_connections_provider_config_key_unique').on(table.providerConfigKey),
    index('nango_connections_nango_connection_id_idx').on(table.nangoConnectionId),
    index('nango_connections_status_idx').on(table.status),
    index('nango_connections_deleted_at_idx').on(table.deletedAt),
  ],
);

/**
 * One row per sync run per model — the audit trail behind "sync health" in the
 * WeldConnect UI. Written by the webhook ingest and by manual triggers.
 */
export const nangoSyncRuns = pgTable(
  'nango_sync_runs',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    /** FK to `nango_connections.id` (local row, not the Nango connection id). */
    connectionId: varchar('connection_id', { length: 30 }).notNull(),

    syncName: varchar('sync_name', { length: 100 }).notNull(),
    /** Nango model the run carried, e.g. `HubspotContact`. */
    model: varchar('model', { length: 100 }).notNull(),

    status: varchar('status', { length: 20 }).notNull().default('running').$type<NangoSyncRunStatus>(),
    trigger: varchar('trigger', { length: 20 }).notNull().$type<NangoSyncTrigger>(),
    /** 'INCREMENTAL' | 'INITIAL' | 'FULL' | 'WEBHOOK' as reported by Nango. */
    syncType: varchar('sync_type', { length: 20 }),

    // Counts as reported by Nango…
    recordsAdded: integer('records_added').notNull().default(0),
    recordsUpdated: integer('records_updated').notNull().default(0),
    recordsDeleted: integer('records_deleted').notNull().default(0),
    // …and what our mappers actually did with them.
    recordsCreated: integer('records_created').notNull().default(0),
    recordsModified: integer('records_modified').notNull().default(0),
    recordsSkipped: integer('records_skipped').notNull().default(0),
    recordsFailed: integer('records_failed').notNull().default(0),

    startedAt: timestamp('started_at').notNull().defaultNow(),
    finishedAt: timestamp('finished_at'),
    durationMs: integer('duration_ms'),

    error: text('error'),
    /** First few per-record failures, so support can see the shape of a bad import. */
    errorSamples: jsonb('error_samples').$type<Array<{ externalId: string; message: string }>>(),
  },
  (table) => [
    index('nango_sync_runs_connection_idx').on(table.connectionId, table.createdAt),
    index('nango_sync_runs_status_idx').on(table.status),
  ],
);

export type NangoConnection = typeof nangoConnections.$inferSelect;
export type NewNangoConnection = typeof nangoConnections.$inferInsert;
export type NangoSyncRun = typeof nangoSyncRuns.$inferSelect;
export type NewNangoSyncRun = typeof nangoSyncRuns.$inferInsert;
