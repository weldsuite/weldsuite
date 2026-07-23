import {
  pgTable,
  varchar,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Enrich Field Results — stores the latest enrichment result per field per entity.
 *
 * One row per (enrichFieldId, entityId) combination.
 * Updated via upsert when enrichment tasks complete.
 */
export const enrichFieldResults = pgTable('enrich_field_results', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Which definition this result belongs to
  enrichFieldId: varchar('enrich_field_id', { length: 30 }).notNull(),

  // Entity being enriched
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId: varchar('entity_id', { length: 30 }).notNull(),

  // Denormalized for fast queries (avoids JOIN to definitions)
  provider: varchar('provider', { length: 50 }).notNull(),
  operation: varchar('operation', { length: 50 }).notNull(),

  // Result
  status: varchar('status', { length: 30 }).notNull(), // 'valid', 'invalid', 'found', 'no_result', 'enriched', etc.
  resultData: jsonb('result_data').$type<Record<string, unknown>>(), // score, email, verifiedAt, contactsFound, etc.

  // Link to audit trail
  enrichmentLogId: varchar('enrichment_log_id', { length: 30 }),
}, (table) => [
  uniqueIndex('enrich_field_results_field_entity_idx').on(table.enrichFieldId, table.entityId),
  index('enrich_field_results_entity_idx').on(table.entityType, table.entityId),
]);

export type EnrichFieldResult = typeof enrichFieldResults.$inferSelect;
export type NewEnrichFieldResult = typeof enrichFieldResults.$inferInsert;
