import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Denormalized matcher rows derived from `workflows.triggers` JSONB.
 * Not a second CRUD API — synced when a workflow is created/updated/activated.
 */
export type TriggerIndexCategory =
  | 'schedule'
  | 'entity_event'
  | 'integration_event'
  | 'webhook'
  | 'manual'
  | 'api'
  | 'workflow_complete';

export const workflowTriggerIndex = pgTable(
  'workflow_trigger_index',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    workflowId: varchar('workflow_id', { length: 30 }).notNull(),
    triggerId: varchar('trigger_id', { length: 30 }).notNull(),
    category: varchar('category', { length: 30 }).notNull().$type<TriggerIndexCategory>(),
    isEnabled: boolean('is_enabled').notNull().default(true),

    /** entity_event */
    entityType: varchar('entity_type', { length: 100 }),
    eventType: varchar('event_type', { length: 50 }),

    /** integration_event */
    provider: varchar('provider', { length: 100 }),
    integrationEvent: varchar('integration_event', { length: 150 }),
    integrationId: varchar('integration_id', { length: 30 }),

    /** workflow_complete */
    sourceWorkflowId: varchar('source_workflow_id', { length: 30 }),

    /** Optional filter snapshot for matcher pre-checks */
    filters: jsonb('filters').$type<Array<{ field: string; operator: string; value: unknown }>>(),
  },
  (table) => [
    uniqueIndex('workflow_trigger_index_workflow_trigger_uidx').on(table.workflowId, table.triggerId),
    index('workflow_trigger_index_workflow_idx').on(table.workflowId),
    index('workflow_trigger_index_category_idx').on(table.category),
    index('workflow_trigger_index_entity_event_idx').on(
      table.category,
      table.entityType,
      table.eventType,
      table.isEnabled,
    ),
    index('workflow_trigger_index_integration_event_idx').on(
      table.category,
      table.provider,
      table.integrationEvent,
      table.isEnabled,
    ),
    index('workflow_trigger_index_source_workflow_idx').on(table.sourceWorkflowId),
  ],
);

export type WorkflowTriggerIndex = typeof workflowTriggerIndex.$inferSelect;
export type NewWorkflowTriggerIndex = typeof workflowTriggerIndex.$inferInsert;
