import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Sync log status
 */
export type SyncLogStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Platform type for sync logs
 */
export type SyncLogPlatform = 'woocommerce' | 'shopify' | 'attio' | 'hubspot' | 'salesforce' | 'pipedrive';

/**
 * Sync type
 */
export type SyncLogType = 'products' | 'orders' | 'customers' | 'collections' | 'variants' | 'fulfillments' | 'companies' | 'people' | 'contacts' | 'leads' | 'opportunities' | 'activities' | 'all';

/**
 * Trigger type
 */
export type SyncTriggerType = 'manual' | 'scheduled' | 'webhook';

/**
 * Generic sync logs table
 * Tracks sync operations for any platform integration
 */
export const syncLogs = pgTable(
  'sync_logs',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    // Platform and connection
    platform: varchar('platform', { length: 30 }).notNull().$type<SyncLogPlatform>(),
    connectionId: varchar('connection_id', { length: 30 }).notNull(),

    // Sync type
    syncType: varchar('sync_type', { length: 30 }).notNull().$type<SyncLogType>(),

    // Status
    status: varchar('status', { length: 20 }).notNull().default('pending').$type<SyncLogStatus>(),

    // Job tracking
    jobId: varchar('job_id', { length: 100 }), // BullMQ job ID

    // Trigger info
    triggeredBy: varchar('triggered_by', { length: 20 }).notNull().$type<SyncTriggerType>(),
    triggeredByUser: varchar('triggered_by_user', { length: 255 }),

    // Progress
    itemsProcessed: integer('items_processed').notNull().default(0),
    totalItems: integer('total_items').notNull().default(0),
    itemsCreated: integer('items_created').notNull().default(0),
    itemsUpdated: integer('items_updated').notNull().default(0),
    itemsFailed: integer('items_failed').notNull().default(0),
    itemsSkipped: integer('items_skipped').notNull().default(0),

    // Timing
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    durationMs: integer('duration_ms'),

    // Error tracking
    errorMessage: text('error_message'),
    errors: jsonb('errors').$type<
      Array<{
        itemId: string | number;
        error: string;
        timestamp: string;
      }>
    >(),

    // Sync direction and entity type
    direction: varchar('direction', { length: 15 }).$type<'inbound' | 'outbound'>(),
    entityType: varchar('entity_type', { length: 50 }),

    // Additional metadata
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('sync_logs_platform_idx').on(table.platform),
    index('sync_logs_connection_idx').on(table.connectionId),
    index('sync_logs_status_idx').on(table.status),
    index('sync_logs_created_at_idx').on(table.createdAt),
    index('sync_logs_job_id_idx').on(table.jobId),
  ]
);

export type SyncLog = typeof syncLogs.$inferSelect;
export type NewSyncLog = typeof syncLogs.$inferInsert;
