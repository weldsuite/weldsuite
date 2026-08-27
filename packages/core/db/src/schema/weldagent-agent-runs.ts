import {
  pgTable,
  varchar,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';

export interface WeldagentAgentRunResult {
  summary: string;
  actionsPerformed: Array<{
    tool: string;
    description: string;
    success: boolean;
  }>;
  toolInvocations?: Array<{
    toolName: string;
    state: 'call' | 'result' | 'error';
    args?: unknown;
    result?: unknown;
  }>;
}

/**
 * Execution log for a workspace AI agent run (manual, event, or chat-backed).
 */
export const weldagentAgentRuns = pgTable(
  'weldagent_agent_runs',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    agentId: varchar('agent_id', { length: 30 }).notNull(),

    /** queued | running | completed | failed | cancelled */
    status: varchar('status', { length: 20 }).notNull(),

    /** manual | event | chat */
    triggerType: varchar('trigger_type', { length: 20 }),
    triggerData: jsonb('trigger_data').$type<Record<string, unknown>>(),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    totalIterations: integer('total_iterations').default(0),
    totalTokensUsed: integer('total_tokens_used').default(0),
    toolCallCount: integer('tool_call_count').default(0),

    result: jsonb('result').$type<WeldagentAgentRunResult>(),
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('weldagent_agent_runs_agent_id_idx').on(table.agentId),
    index('weldagent_agent_runs_status_idx').on(table.status),
    index('weldagent_agent_runs_created_at_idx').on(table.createdAt),
  ],
);

export type WeldagentAgentRun = typeof weldagentAgentRuns.$inferSelect;
export type NewWeldagentAgentRun = typeof weldagentAgentRuns.$inferInsert;
