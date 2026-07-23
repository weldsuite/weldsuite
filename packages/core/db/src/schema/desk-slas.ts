import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { DeskViewFilter } from './desk-views';

/**
 * WeldDesk v2 — SLA definitions + per-conversation SLA application.
 *
 * Semantics (Intercom model):
 * - One ACTIVE SLA per conversation — first writer wins; later applications
 *   are ignored (enforced by partial-unique behavior in the service layer
 *   plus the unique active index below).
 * - Targets run on office-hour or calendar clocks.
 * - Timers pause while snoozed and (configurable) while a ticket is in a
 *   waiting_on_customer state.
 * - Misses are recorded lazily: on the next teammate reply, not at expiry.
 */

export interface DeskSlaTargets {
  /** All in minutes; omit a target to not track it. */
  firstReplyTime?: number;
  nextReplyTime?: number;
  timeToClose?: number;
  timeToResolve?: number;
}

export const deskSlas = pgTable(
  'desk_slas',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    /** Audience conditions for auto-application (same predicate shape as views). */
    conditions: jsonb('conditions').$type<DeskViewFilter>(),
    targets: jsonb('targets').$type<DeskSlaTargets>().notNull(),
    clock: varchar('clock', { length: 15 }).$type<'office_hours' | 'calendar'>().notNull().default('office_hours'),
    pauseOnSnooze: boolean('pause_on_snooze').notNull().default(true),
    pauseOnWaitingOnCustomer: boolean('pause_on_waiting_on_customer').notNull().default(true),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [index('desk_slas_archived_idx').on(table.archived)],
);

export type DeskSlaStatus = 'active' | 'hit' | 'missed' | 'cancelled';

export interface DeskSlaTargetState {
  deadline: string; // ISO timestamp
  hitAt?: string;
  missedAt?: string;
  /** Accumulated paused milliseconds, used to recompute deadlines on resume. */
  pausedMs?: number;
  pausedAt?: string;
}

export const deskConversationSlas = pgTable(
  'desk_conversation_slas',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    conversationId: varchar('conversation_id', { length: 30 }).notNull(),
    slaId: varchar('sla_id', { length: 30 }).notNull(),
    status: varchar('status', { length: 10 }).$type<DeskSlaStatus>().notNull().default('active'),
    /** Per-target deadline/hit/miss state, keyed by target name. */
    targetStates: jsonb('target_states').$type<Partial<Record<keyof DeskSlaTargets, DeskSlaTargetState>>>().notNull(),
    /** The next deadline across all pending targets — drives sort + cron sweep. */
    nextDeadline: timestamp('next_deadline'),
  },
  (table) => [
    // One SLA row per conversation total (application replaces nothing; first wins).
    uniqueIndex('desk_conversation_slas_conversation_idx').on(table.conversationId),
    index('desk_conversation_slas_next_deadline_idx').on(table.status, table.nextDeadline),
  ],
);

export type DeskSla = typeof deskSlas.$inferSelect;
export type NewDeskSla = typeof deskSlas.$inferInsert;
export type DeskConversationSla = typeof deskConversationSlas.$inferSelect;
export type NewDeskConversationSla = typeof deskConversationSlas.$inferInsert;
