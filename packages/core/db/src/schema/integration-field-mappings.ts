import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Sync direction for a field mapping
 */
export type FieldMappingDirection = 'inbound' | 'outbound' | 'bidirectional';

/**
 * Transform type for field value conversion
 */
export type FieldTransformType = 'direct' | 'lookup' | 'format_date' | 'custom';

/**
 * Per-entity, per-field mapping between WeldSuite and an external CRM.
 * Users can fully customize which fields sync, in which direction, and how values are transformed.
 * Only fields with an active mapping row are synced.
 */
export const integrationFieldMappings = pgTable(
  'integration_field_mappings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    // Connection reference
    connectionId: varchar('connection_id', { length: 30 }).notNull(),

    // Entity type this mapping applies to
    entityType: varchar('entity_type', { length: 50 }).notNull(),

    // Field paths (dot-notation for nested JSONB fields)
    externalFieldPath: varchar('external_field_path', { length: 255 }).notNull(),
    internalFieldPath: varchar('internal_field_path', { length: 255 }).notNull(),

    // Sync direction for this specific field
    direction: varchar('direction', { length: 15 }).notNull().default('bidirectional').$type<FieldMappingDirection>(),

    // Value transformation
    transformType: varchar('transform_type', { length: 30 }).notNull().default('direct').$type<FieldTransformType>(),
    transformConfig: jsonb('transform_config').$type<Record<string, unknown>>(),

    // Flags
    isRequired: boolean('is_required').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),

    // Ordering within the entity type
    position: integer('position').notNull().default(0),
  },
  (table) => [
    index('integration_field_mappings_connection_entity_idx').on(table.connectionId, table.entityType),
    uniqueIndex('integration_field_mappings_unique_field').on(table.connectionId, table.entityType, table.externalFieldPath),
  ]
);

export type IntegrationFieldMapping = typeof integrationFieldMappings.$inferSelect;
export type NewIntegrationFieldMapping = typeof integrationFieldMappings.$inferInsert;
