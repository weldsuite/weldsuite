import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Conflict type
 */
export type SyncConflictType = 'field_mismatch' | 'delete_conflict' | 'create_duplicate';

/**
 * Conflict resolution status
 */
export type SyncConflictResolution = 'pending' | 'keep_internal' | 'keep_external' | 'merged' | 'dismissed';

/**
 * Tracks sync conflicts between WeldSuite and external CRM records.
 * Created when the conflict strategy is 'manual' and a bidirectional sync
 * detects that both sides have changed the same record.
 */
export const integrationSyncConflicts = pgTable(
  'integration_sync_conflicts',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    // Connection reference
    connectionId: varchar('connection_id', { length: 30 }).notNull(),

    // Entity info
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    internalEntityId: varchar('internal_entity_id', { length: 30 }).notNull(),
    externalEntityId: varchar('external_entity_id', { length: 255 }).notNull(),

    // Conflict details
    conflictType: varchar('conflict_type', { length: 30 }).notNull().$type<SyncConflictType>(),
    internalData: jsonb('internal_data').notNull().$type<Record<string, unknown>>(),
    externalData: jsonb('external_data').notNull().$type<Record<string, unknown>>(),
    conflictFields: jsonb('conflict_fields').$type<string[]>(),

    // Resolution
    resolution: varchar('resolution', { length: 20 }).notNull().default('pending').$type<SyncConflictResolution>(),
    resolvedAt: timestamp('resolved_at'),
    resolvedBy: varchar('resolved_by', { length: 255 }),
  },
  (table) => [
    index('integration_sync_conflicts_connection_resolution_idx').on(table.connectionId, table.resolution),
    index('integration_sync_conflicts_entity_idx').on(table.entityType, table.internalEntityId),
  ]
);

export type IntegrationSyncConflict = typeof integrationSyncConflicts.$inferSelect;
export type NewIntegrationSyncConflict = typeof integrationSyncConflicts.$inferInsert;
