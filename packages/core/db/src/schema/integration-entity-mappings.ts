import {
  pgTable,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Maps external records (from any integration provider) to internal WeldSuite entities.
 * Provider-agnostic — works for Attio, HubSpot, Salesforce, etc.
 */
export const integrationEntityMappings = pgTable(
  'integration_entity_mappings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    // Connection reference
    connectionId: varchar('connection_id', { length: 30 }).notNull(),

    // External entity
    externalEntityType: varchar('external_entity_type', { length: 50 }).notNull(), // 'person' | 'company' | 'deal'
    externalEntityId: varchar('external_entity_id', { length: 255 }).notNull(),

    // Internal WeldSuite entity
    internalEntityType: varchar('internal_entity_type', { length: 50 }).notNull(), // 'customer' | 'contact'
    internalEntityId: varchar('internal_entity_id', { length: 30 }).notNull(),

    // Sync metadata
    lastSyncedAt: timestamp('last_synced_at'),
    syncChecksum: varchar('sync_checksum', { length: 64 }), // SHA-256 for change detection
  },
  (table) => [
    uniqueIndex('integration_entity_mappings_unique').on(
      table.connectionId,
      table.externalEntityType,
      table.externalEntityId
    ),
    index('integration_entity_mappings_connection_idx').on(table.connectionId),
    index('integration_entity_mappings_external_idx').on(table.externalEntityType, table.externalEntityId),
    index('integration_entity_mappings_internal_idx').on(table.internalEntityType, table.internalEntityId),
  ]
);

export type IntegrationEntityMapping = typeof integrationEntityMappings.$inferSelect;
export type NewIntegrationEntityMapping = typeof integrationEntityMappings.$inferInsert;
