import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Enrichment status enum values
 */
export const ENRICHMENT_STATUS = ['pending', 'processing', 'success', 'error', 'no_result'] as const;
export type EnrichmentStatus = (typeof ENRICHMENT_STATUS)[number];

/**
 * Enrichment operation types
 */
export const ENRICHMENT_OPERATIONS = ['email_finder', 'email_verifier', 'domain_search'] as const;
export type EnrichmentOperation = (typeof ENRICHMENT_OPERATIONS)[number];

/**
 * Enrichment logs - tracks every data enrichment API call for audit and credit tracking
 */
export const enrichmentLogs = pgTable('enrichment_logs', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),

  // Provider info
  provider: varchar('provider', { length: 50 }).notNull(), // 'hunter'
  operation: varchar('operation', { length: 50 }).notNull(), // 'email_finder' | 'email_verifier' | 'domain_search'

  // Entity being enriched
  entityType: varchar('entity_type', { length: 30 }).notNull(), // 'contact' | 'customer'
  entityId: varchar('entity_id', { length: 30 }).notNull(),

  // Who triggered it
  userId: varchar('user_id', { length: 255 }).notNull(),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),

  // Request/response
  requestParams: jsonb('request_params').$type<Record<string, unknown>>(),
  responseData: jsonb('response_data').$type<Record<string, unknown>>(),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending, processing, success, error, no_result
  errorMessage: text('error_message'),

  // Credits
  creditsUsed: integer('credits_used'),

  // Trigger.dev task tracking
  triggerTaskId: varchar('trigger_task_id', { length: 255 }),
}, (table) => [
  index('enrichment_logs_entity_idx').on(table.entityType, table.entityId),
  index('enrichment_logs_provider_idx').on(table.provider),
  index('enrichment_logs_created_at_idx').on(table.createdAt),
  index('enrichment_logs_status_idx').on(table.status),
]);

export type EnrichmentLog = typeof enrichmentLogs.$inferSelect;
export type NewEnrichmentLog = typeof enrichmentLogs.$inferInsert;
