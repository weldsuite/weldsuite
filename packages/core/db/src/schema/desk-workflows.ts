import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { MessageBlock } from './welddesk-blocks';
import type { DeskViewFilter } from './desk-views';
import type { DeskChannel } from './desk-conversations';

/**
 * WeldDesk v2 — Intercom-Workflows-model automation engine schema.
 *
 * Execution invariants (enforced by the conversation Durable Object in
 * apps/workers/helpdesk-workflow-worker — see .claude/welddesk-intercom-plan.md §2):
 * - ONE customer-facing workflow execution per conversation at a time; the
 *   slot is held across reply-waits until the run ends or is interrupted.
 * - All matching background workflows run in parallel.
 * - Global evaluation order = priorityRank (drag-order list, ascending).
 * - Executions pin the workflow VERSION live at trigger time; publishing
 *   or pausing never mutates in-flight runs.
 * - Assignments from background workflows are deferred while a
 *   customer-facing run holds the conversation.
 */

// ── Triggers ────────────────────────────────────────────────────────────────

export type DeskWorkflowTrigger =
  // customer-facing entry points
  | 'customer_opens_messenger' // new-conversation composer opened, pre-typing
  | 'customer_sends_first_message' // first message of a new conversation (any channel)
  // background
  | 'customer_sends_any_message'
  | 'customer_unresponsive'
  | 'teammate_changes_state'
  | 'teammate_changes_assignment'
  | 'teammate_adds_note'
  | 'ticket_created'
  | 'teammate_changes_ticket_state'
  | 'ai_closes_conversation'
  // chaining — callable subroutine, no audience/scheduling
  | 'reusable';

// ── Steps ───────────────────────────────────────────────────────────────────

export interface DeskStepBase {
  id: string;
  type: string;
}

/** Rich bot message; replyButtons each start a branch path. */
export interface DeskSendMessageStep extends DeskStepBase {
  type: 'send_message';
  blocks: MessageBlock[];
  replyButtons?: { id: string; label: string; nextPathId: string }[];
}

export interface DeskCollectDataStep extends DeskStepBase {
  type: 'collect_data';
  prompt?: string;
  /** Where the collected value lands. */
  target: { kind: 'conversation_attribute' | 'contact_attribute'; attributeId: string };
  inputType: 'text' | 'email' | 'phone' | 'number' | 'select' | 'date';
  options?: { id: string; label: string }[];
}

/** Free-text reply gate — re-enables the composer and waits. */
export interface DeskCollectReplyStep extends DeskStepBase {
  type: 'collect_reply';
}

/** Hand the conversation to the AI agent. */
export interface DeskLetAiAnswerStep extends DeskStepBase {
  type: 'let_ai_answer';
  /** Path taken when the AI can't answer or gets negative feedback. */
  cantAnswerPathId?: string;
  /** Path taken when the customer explicitly asks for a human. */
  humanRequestPathId?: string;
  /** Send expectation-setting messages on handover. */
  handoverExpectations?: boolean;
  /** Let the AI close on confirmed resolution. */
  closeOnResolution?: boolean;
}

export interface DeskShowReplyTimeStep extends DeskStepBase {
  type: 'show_reply_time';
}

/** Present a ticket form (customer tickets only). */
export interface DeskSendTicketFormStep extends DeskStepBase {
  type: 'send_ticket_form';
  ticketTypeId: string;
}

/** Conditional routing — first matching branch wins, top-to-bottom. */
export interface DeskBranchesStep extends DeskStepBase {
  type: 'branches';
  branches: { id: string; label?: string; conditions: DeskViewFilter; nextPathId: string }[];
  /** Fallback path when nothing matches. */
  elsePathId?: string;
}

/** Mini rules engine — EVERY matching rule's actions execute (multi-match). */
export interface DeskApplyRulesStep extends DeskStepBase {
  type: 'apply_rules';
  rules: { id: string; conditions: DeskViewFilter; actions: DeskWorkflowAction[] }[];
}

export interface DeskActionStep extends DeskStepBase {
  type: 'action';
  action: DeskWorkflowAction;
}

export interface DeskWaitStep extends DeskStepBase {
  type: 'wait';
  durationMinutes: number;
  interruptOnCustomerReply?: boolean;
  interruptOnTeammateReply?: boolean;
  interruptOnClose?: boolean;
}

/** Call/return semantics: control returns to the parent when the child ends. */
export interface DeskPassToReusableStep extends DeskStepBase {
  type: 'pass_to_reusable';
  workflowId: string;
}

/** Outbound HTTP call; response fields map into execution variables. 15s timeout. */
export interface DeskCustomActionStep extends DeskStepBase {
  type: 'custom_action';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  /** JSONPath-ish mappings from response → variables. */
  responseMappings?: { variable: string; path: string }[];
  errorPathId?: string;
}

export type DeskWorkflowAction =
  | { type: 'add_tag'; tag: string }
  | { type: 'remove_tag'; tag: string }
  | { type: 'assign'; assigneeType: 'admin' | 'team'; assigneeId: string }
  | { type: 'snooze'; durationMinutes: number }
  | { type: 'close' }
  | { type: 'reopen' }
  | { type: 'mark_priority'; priority: boolean }
  | { type: 'apply_sla'; slaId: string } // first-writer-wins
  | { type: 'add_note'; body: string; mentionUserIds?: string[] }
  | { type: 'set_conversation_attribute'; attributeId: string; value: unknown }
  | { type: 'set_ticket_state'; ticketStateId: string }
  | { type: 'disable_composer' }
  | { type: 'convert_to_ticket'; ticketTypeId: string };

export type DeskWorkflowStep =
  | DeskSendMessageStep
  | DeskCollectDataStep
  | DeskCollectReplyStep
  | DeskLetAiAnswerStep
  | DeskShowReplyTimeStep
  | DeskSendTicketFormStep
  | DeskBranchesStep
  | DeskApplyRulesStep
  | DeskActionStep
  | DeskWaitStep
  | DeskPassToReusableStep
  | DeskCustomActionStep;

/** A path is an ordered list of steps; branches/buttons jump between paths. */
export interface DeskWorkflowPath {
  id: string;
  /** Path A (bound to the trigger) is undeletable in the builder. */
  isEntry?: boolean;
  title?: string;
  steps: DeskWorkflowStep[];
  /** Reconvergence: continue into another path when this one's steps finish. */
  nextPathId?: string;
}

export interface DeskWorkflowGraph {
  paths: DeskWorkflowPath[];
}

export interface DeskWorkflowScheduling {
  mode: 'any_time' | 'during_office_hours' | 'outside_office_hours' | 'custom';
  /** For mode=custom: weekly grid in workspace timezone. */
  customHours?: Record<string, { start: string; end: string }[]>;
}

// ── Tables ──────────────────────────────────────────────────────────────────

export const deskWorkflows = pgTable(
  'desk_workflows',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    /** Immutable after creation (Intercom rule — recreate to change). */
    trigger: varchar('trigger', { length: 40 }).$type<DeskWorkflowTrigger>().notNull(),
    /** Derived on publish from whether the graph contains customer-visible steps. */
    classification: varchar('classification', { length: 20 })
      .$type<'customer_facing' | 'background'>()
      .notNull()
      .default('background'),
    status: varchar('status', { length: 10 }).$type<'draft' | 'live' | 'paused'>().notNull().default('draft'),
    /** Global drag-order evaluation priority (ascending = first). */
    priorityRank: integer('priority_rank').notNull().default(0),

    /** Audience predicates (not for trigger=reusable). */
    audienceRules: jsonb('audience_rules').$type<DeskViewFilter>(),
    channels: jsonb('channels').$type<DeskChannel[]>(),
    scheduling: jsonb('scheduling').$type<DeskWorkflowScheduling>(),

    /** Reusable workflows can be triggered manually from the inbox (⌘K). */
    inboxTriggerable: boolean('inbox_triggerable').notNull().default(false),

    /** Points at the desk_workflow_versions row currently serving. */
    liveVersionId: varchar('live_version_id', { length: 30 }),
  },
  (table) => [
    index('desk_workflows_trigger_idx').on(table.trigger, table.status),
    index('desk_workflows_priority_idx').on(table.priorityRank),
  ],
);

export const deskWorkflowVersions = pgTable(
  'desk_workflow_versions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    workflowId: varchar('workflow_id', { length: 30 }).notNull(),
    versionNumber: integer('version_number').notNull(),
    graph: jsonb('graph').$type<DeskWorkflowGraph>().notNull(),
    /** Null = draft (auto-saved working copy; at most one per workflow). */
    publishedAt: timestamp('published_at'),
    publishedBy: varchar('published_by', { length: 255 }),
  },
  (table) => [
    uniqueIndex('desk_workflow_versions_number_idx').on(table.workflowId, table.versionNumber),
  ],
);

export type DeskExecutionStatus =
  | 'running'
  | 'waiting_reply'
  | 'waiting_timer'
  | 'completed'
  | 'interrupted' // teammate action or manual reusable trigger stopped it
  | 'failed';

export const deskWorkflowExecutions = pgTable(
  'desk_workflow_executions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    workflowId: varchar('workflow_id', { length: 30 }).notNull(),
    /** Version pinned at trigger time — the run completes on this version. */
    versionId: varchar('version_id', { length: 30 }).notNull(),
    conversationId: varchar('conversation_id', { length: 30 }).notNull(),
    classification: varchar('classification', { length: 20 })
      .$type<'customer_facing' | 'background'>()
      .notNull(),
    status: varchar('status', { length: 15 }).$type<DeskExecutionStatus>().notNull().default('running'),
    currentPathId: varchar('current_path_id', { length: 60 }),
    currentStepId: varchar('current_step_id', { length: 60 }),
    /** Collected data + custom-action response mappings. */
    variables: jsonb('variables').$type<Record<string, unknown>>(),
    /** Parent execution when running as a reusable-workflow call. */
    parentExecutionId: varchar('parent_execution_id', { length: 30 }),
    endedAt: timestamp('ended_at'),
    error: text('error'),
  },
  (table) => [
    index('desk_workflow_executions_conversation_idx').on(table.conversationId, table.status),
    index('desk_workflow_executions_workflow_idx').on(table.workflowId, table.createdAt),
  ],
);

/**
 * Per-conversation chronological trigger-evaluation log — the
 * "Troubleshoot Workflows" timeline. One row per trigger event evaluated,
 * whether or not a workflow fired.
 */
export const deskWorkflowTriggerLog = pgTable(
  'desk_workflow_trigger_log',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    conversationId: varchar('conversation_id', { length: 30 }).notNull(),
    trigger: varchar('trigger', { length: 40 }).$type<DeskWorkflowTrigger>().notNull(),
    /** Workflows evaluated in priority order: id + whether matched + why not. */
    evaluations: jsonb('evaluations').$type<
      { workflowId: string; matched: boolean; reason?: string }[]
    >(),
    /** Execution started as a result, if any. */
    executionId: varchar('execution_id', { length: 30 }),
  },
  (table) => [index('desk_workflow_trigger_log_conversation_idx').on(table.conversationId, table.createdAt)],
);

export type DeskWorkflow = typeof deskWorkflows.$inferSelect;
export type NewDeskWorkflow = typeof deskWorkflows.$inferInsert;
export type DeskWorkflowVersion = typeof deskWorkflowVersions.$inferSelect;
export type NewDeskWorkflowVersion = typeof deskWorkflowVersions.$inferInsert;
export type DeskWorkflowExecution = typeof deskWorkflowExecutions.$inferSelect;
export type NewDeskWorkflowExecution = typeof deskWorkflowExecutions.$inferInsert;
export type DeskWorkflowTriggerLogEntry = typeof deskWorkflowTriggerLog.$inferSelect;
export type NewDeskWorkflowTriggerLogEntry = typeof deskWorkflowTriggerLog.$inferInsert;
