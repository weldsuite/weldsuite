import {
  pgTable,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Workspace AI agents (WeldAgent).
 *
 * Named, permission-scoped agents that can chat with tools and/or run on
 * entity events. Distinct from helpdesk_agents (human support roster).
 */
export const weldagentAgents = pgTable(
  'weldagent_agents',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    icon: varchar('icon', { length: 50 }),

    /** draft | active | paused */
    status: varchar('status', { length: 20 }).notNull().default('draft'),

    /** Natural-language instructions / system prompt. */
    systemPrompt: text('system_prompt').notNull().default(''),

    modelId: varchar('model_id', { length: 100 }).notNull().default('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
    temperature: varchar('temperature', { length: 10 }).notNull().default('0.70'),
    maxTokens: integer('max_tokens').notNull().default(2048),

    /**
     * Platform object:action grants that filter which tools this agent may call.
     * Same shape as custom role permissions (e.g. `contacts:read`, `tickets:create`).
     */
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),

    /**
     * Optional explicit tool-id allow-list. When empty, all tools whose
     * requiredPermissions are covered by `permissions` are available.
     */
    enabledTools: jsonb('enabled_tools').$type<string[]>().notNull().default([]),

    /** Entity event keys this agent listens for, e.g. `["person.created"]`. */
    eventSubscriptions: jsonb('event_subscriptions').$type<string[]>().notNull().default([]),

    maxIterations: integer('max_iterations').notNull().default(10),
    maxTotalTokens: integer('max_total_tokens').notNull().default(20000),

    createdBy: varchar('created_by', { length: 255 }),

    totalRuns: integer('total_runs').notNull().default(0),
    successfulRuns: integer('successful_runs').notNull().default(0),
    failedRuns: integer('failed_runs').notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunStatus: varchar('last_run_status', { length: 20 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldagent_agents_status_idx').on(table.status),
    index('weldagent_agents_deleted_at_idx').on(table.deletedAt),
  ],
);

export type WeldagentAgent = typeof weldagentAgents.$inferSelect;
export type NewWeldagentAgent = typeof weldagentAgents.$inferInsert;
