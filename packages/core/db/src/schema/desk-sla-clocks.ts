import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { BusinessHours } from './helpdesk-slas';

/**
 * WeldDesk SLA clocks — one row per conversation and metric.
 *
 * Written only by refreshDeskSla in @weldsuite/db/lib/desk-sla, which derives
 * every clock from the conversation's timeline (desk_messages) and the SLA
 * policy that matches it (helpdesk_slas), so a row can always be rebuilt.
 *
 * metric:
 *   first_response — first visitor message → first agent reply
 *   next_response  — each later visitor message after an agent reply → the
 *                    next agent reply (one row, restarted per cycle)
 *   resolution     — first message → close; paused while the team has
 *                    answered and waits on the customer
 *
 * Times are business time on `calendar` (null = 24x7), snapshotted from the
 * policy when the clock was derived. `next_check_at` is when the sweep must
 * look at the clock again (a warning or a breach coming due); the workspace's
 * earliest one is mirrored into the D1 due index (kind `desk_sla`).
 */

export type DeskSlaMetric = 'first_response' | 'next_response' | 'resolution';

/** running: counting · paused: waiting on the customer · completed: met its end · cancelled: closed before it could. */
export type DeskSlaClockStatus = 'running' | 'paused' | 'completed' | 'cancelled';

export const deskSlaClocks = pgTable(
  'desk_sla_clocks',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    conversationId: varchar('conversation_id', { length: 30 }).notNull(),
    metric: varchar('metric', { length: 20 }).$type<DeskSlaMetric>().notNull(),
    policyId: varchar('policy_id', { length: 30 }),

    targetMinutes: integer('target_minutes').notNull(),
    /** Business minutes before the due time at which agents are warned; null = no warning. */
    warnBeforeMinutes: integer('warn_before_minutes'),
    calendar: jsonb('calendar').$type<BusinessHours | null>(),

    status: varchar('status', { length: 10 }).$type<DeskSlaClockStatus>().notNull(),
    /** Start of the current cycle. */
    startedAt: timestamp('started_at').notNull(),
    /** Business seconds counted so far (up to the derivation, or to the end of the clock). */
    elapsedSeconds: integer('elapsed_seconds').notNull().default(0),
    /** When running: the projected breach time. */
    dueAt: timestamp('due_at'),
    /** When running: when the warning comes due. */
    warnAt: timestamp('warn_at'),
    /** When the target was exceeded (null: not, or not yet). */
    breachedAt: timestamp('breached_at'),
    completedAt: timestamp('completed_at'),

    /** When the warning was sent for this cycle. */
    warnedAt: timestamp('warned_at'),
    /** When the breach was announced for this cycle. */
    breachNotifiedAt: timestamp('breach_notified_at'),

    nextCheckAt: timestamp('next_check_at'),
  },
  (table) => [
    uniqueIndex('desk_sla_clocks_conversation_metric_uidx').on(table.conversationId, table.metric),
    index('desk_sla_clocks_next_check_idx').on(table.nextCheckAt),
  ],
);

export type DeskSlaClock = typeof deskSlaClocks.$inferSelect;
export type NewDeskSlaClock = typeof deskSlaClocks.$inferInsert;
