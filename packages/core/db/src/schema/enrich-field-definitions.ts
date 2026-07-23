import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Enrich Field Definitions — configures which enrichment operations are enabled per entity type.
 *
 * Each row represents one provider+operation pair (e.g. Hunter email_verifier for contacts).
 * The frontend registry maps (provider, operation) to a cell component and logo.
 */
export const enrichFieldDefinitions = pgTable('enrich_field_definitions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Provider info
  provider: varchar('provider', { length: 50 }).notNull(), // e.g. 'hunter'
  operation: varchar('operation', { length: 50 }).notNull(), // e.g. 'email_verifier'

  // Which entity type this field appears on
  entityType: varchar('entity_type', { length: 50 }).notNull(), // 'contact' | 'customer'

  // Display
  name: varchar('name', { length: 100 }).notNull(), // user-customizable label
  slug: varchar('slug', { length: 100 }).notNull(), // stable key for column IDs

  // State
  enabled: boolean('enabled').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),

  // Provider-specific overrides (optional)
  config: jsonb('config').$type<Record<string, unknown>>(),
}, (table) => [
  uniqueIndex('enrich_field_def_provider_op_entity_idx').on(table.provider, table.operation, table.entityType),
  index('enrich_field_def_entity_type_idx').on(table.entityType),
]);

export type EnrichFieldDefinition = typeof enrichFieldDefinitions.$inferSelect;
export type NewEnrichFieldDefinition = typeof enrichFieldDefinitions.$inferInsert;
