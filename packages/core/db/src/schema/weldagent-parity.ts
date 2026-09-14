import {
  pgTable,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Grok-parity tables for WeldAgent: skills, routines, approvals, memory, templates.
 */

export const weldagentSkills = pgTable(
  'weldagent_skills',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    /** Steps, decision rules, expected output, safety boundaries. */
    instructions: text('instructions').notNull(),
    /** draft | active | archived */
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    /**
     * Optional structured steps from teach-by-demonstration.
     * e.g. [{ action, url?, selector?, text?, note? }]
     */
    steps: jsonb('steps').$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdBy: varchar('created_by', { length: 255 }),
    sourceAgentId: varchar('source_agent_id', { length: 30 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldagent_skills_status_idx').on(table.status),
    index('weldagent_skills_deleted_at_idx').on(table.deletedAt),
  ],
);

/** Which skills an agent may use. */
export const weldagentAgentSkills = pgTable(
  'weldagent_agent_skills',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    agentId: varchar('agent_id', { length: 30 }).notNull(),
    skillId: varchar('skill_id', { length: 30 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('weldagent_agent_skills_unique').on(table.agentId, table.skillId),
    index('weldagent_agent_skills_agent_idx').on(table.agentId),
  ],
);

export const weldagentRoutines = pgTable(
  'weldagent_routines',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    agentId: varchar('agent_id', { length: 30 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    instructions: text('instructions').notNull(),
    /** Optional skill to run. */
    skillId: varchar('skill_id', { length: 30 }),
    /**
     * Schedule kind:
     * - cron: five-field cron in `cronExpr` + timezone
     * - event: platform entity event key in `eventKey`
     * - connector: slack/github match rule in `connectorConfig`
     */
    scheduleKind: varchar('schedule_kind', { length: 20 }).notNull().default('cron'),
    cronExpr: varchar('cron_expr', { length: 100 }),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    eventKey: varchar('event_key', { length: 100 }),
    connectorConfig: jsonb('connector_config').$type<{
      provider?: 'slack' | 'github';
      channel?: string;
      match?: string;
      repo?: string;
      event?: string;
    } | null>(),
    enabled: boolean('enabled').notNull().default(true),
    requireApproval: boolean('require_approval').notNull().default(false),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldagent_routines_agent_idx').on(table.agentId),
    index('weldagent_routines_next_run_idx').on(table.nextRunAt),
    index('weldagent_routines_enabled_idx').on(table.enabled),
  ],
);

export const weldagentRoutineRuns = pgTable(
  'weldagent_routine_runs',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    routineId: varchar('routine_id', { length: 30 }).notNull(),
    agentId: varchar('agent_id', { length: 30 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('queued'),
    trigger: varchar('trigger', { length: 40 }).notNull().default('schedule'),
    summary: text('summary'),
    error: text('error'),
    agentRunId: varchar('agent_run_id', { length: 30 }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('weldagent_routine_runs_routine_idx').on(table.routineId),
    index('weldagent_routine_runs_created_idx').on(table.createdAt),
  ],
);

export const weldagentApprovals = pgTable(
  'weldagent_approvals',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    agentId: varchar('agent_id', { length: 30 }).notNull(),
    conversationId: varchar('conversation_id', { length: 30 }),
    toolName: varchar('tool_name', { length: 100 }).notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull().default({}),
    riskLevel: varchar('risk_level', { length: 20 }).notNull().default('high'),
    /** pending | approved | rejected | auto_approved | expired */
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    reason: text('reason'),
    decidedBy: varchar('decided_by', { length: 255 }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('weldagent_approvals_agent_idx').on(table.agentId),
    index('weldagent_approvals_status_idx').on(table.status),
  ],
);

export const weldagentMemories = pgTable(
  'weldagent_memories',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    agentId: varchar('agent_id', { length: 30 }).notNull(),
    /** preference | fact | summary | correction */
    kind: varchar('kind', { length: 20 }).notNull().default('fact'),
    content: text('content').notNull(),
    source: varchar('source', { length: 100 }),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('weldagent_memories_agent_idx').on(table.agentId),
    index('weldagent_memories_kind_idx').on(table.kind),
  ],
);

export const weldagentTemplates = pgTable(
  'weldagent_templates',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    /** Snapshot: systemPrompt, permissions, enabledTools, skills, routines (no secrets). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    isPublic: boolean('is_public').notNull().default(false),
    shareToken: varchar('share_token', { length: 64 }),
    sourceAgentId: varchar('source_agent_id', { length: 30 }),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('weldagent_templates_share_token_idx').on(table.shareToken),
    index('weldagent_templates_public_idx').on(table.isPublic),
  ],
);

/** Browser teach-session recordings before they become skills. */
export const weldagentTeachSessions = pgTable(
  'weldagent_teach_sessions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    agentId: varchar('agent_id', { length: 30 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('recording'),
    steps: jsonb('steps').$type<Array<Record<string, unknown>>>().notNull().default([]),
    skillId: varchar('skill_id', { length: 30 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    createdBy: varchar('created_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('weldagent_teach_sessions_agent_idx').on(table.agentId)],
);

export type WeldagentSkill = typeof weldagentSkills.$inferSelect;
export type WeldagentRoutine = typeof weldagentRoutines.$inferSelect;
export type WeldagentApproval = typeof weldagentApprovals.$inferSelect;
export type WeldagentMemory = typeof weldagentMemories.$inferSelect;
export type WeldagentTemplate = typeof weldagentTemplates.$inferSelect;
export type WeldagentTeachSession = typeof weldagentTeachSessions.$inferSelect;
