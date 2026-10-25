import {
  pgTable,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
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

    /** Claude model the agent runs on (see WORKSPACE_AGENT_MODELS). */
    modelId: varchar('model_id', { length: 100 }).notNull().default('claude-opus-5-5'),
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

    /**
     * The member responsible for the agent, like a teammate's manager: decides
     * who can use it, can edit it, and receives its approvals. Starts as the
     * creator; null only for agents created before ownership existed.
     */
    ownerId: varchar('owner_id', { length: 255 }),

    /**
     * Who can see and chat with the agent: `private` (owner only), `members`
     * (owner plus the rows in weldagent_agent_members) or `workspace` (every
     * member with weldagent:use). Holders of weldagent:manage see every agent.
     */
    visibility: varchar('visibility', { length: 20 }).notNull().default('workspace'),

    /**
     * Agents this agent may hand work to (its sub-agents, by WeldAgent id).
     * Delegation is one level deep: working as a sub-agent, an agent does not
     * delegate further.
     */
    subagentIds: jsonb('subagent_ids').$type<string[]>().notNull().default([]),
    /** Whether the agent may also hand work to copies of itself. */
    delegateToSelf: boolean('delegate_to_self').notNull().default(false),

    /**
     * The Claude Managed Agents agent object this agent runs as (`agent_…`),
     * its latest synced version, and a hash of the config last pushed to it.
     * Synced lazily before a session starts; a changed hash publishes a new
     * version. Null until the agent first runs.
     */
    anthropicAgentId: varchar('anthropic_agent_id', { length: 100 }),
    anthropicAgentVersion: integer('anthropic_agent_version'),
    anthropicConfigHash: varchar('anthropic_config_hash', { length: 64 }),

    /**
     * The agent object this agent runs as when another agent delegates to it
     * (a sub-agent): no sub-agents of its own, and sandbox / web calls ask the
     * driver first, so a sub-agent never does more than the person chatting.
     * Synced lazily like the main object.
     */
    anthropicWorkerAgentId: varchar('anthropic_worker_agent_id', { length: 100 }),
    anthropicWorkerAgentVersion: integer('anthropic_worker_agent_version'),
    anthropicWorkerConfigHash: varchar('anthropic_worker_config_hash', { length: 64 }),

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

/** Members given access to an agent whose visibility is `members`. */
export const weldagentAgentMembers = pgTable(
  'weldagent_agent_members',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    agentId: varchar('agent_id', { length: 30 }).notNull(),
    userId: varchar('user_id', { length: 255 }).notNull(),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('weldagent_agent_members_agent_user_idx').on(table.agentId, table.userId),
    index('weldagent_agent_members_user_idx').on(table.userId),
  ],
);

export type WeldagentAgentMember = typeof weldagentAgentMembers.$inferSelect;
