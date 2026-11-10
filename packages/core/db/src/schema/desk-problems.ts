import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { DeskPriority } from './desk-conversations';

/**
 * Where a problem stands (ITIL problem management):
 *   - `open`: logged, nobody is on it yet.
 *   - `investigating`: the cause is being looked for.
 *   - `known_error`: the cause is known and there is a workaround, the
 *     permanent fix is still to come.
 *   - `resolved`: the permanent fix is in.
 *   - `closed`: reviewed and done.
 */
export const DESK_PROBLEM_STATUSES = ['open', 'investigating', 'known_error', 'resolved', 'closed'] as const;
export type DeskProblemStatus = (typeof DESK_PROBLEM_STATUSES)[number];

/** A problem that still needs work; `resolved` and `closed` are done. */
export const DESK_PROBLEM_OPEN_STATUSES = ['open', 'investigating', 'known_error'] as const;

/**
 * WeldDesk problem: the cause behind one or more incidents.
 *
 * Incidents are inbox conversations (`desk_conversations.problem_id`); a
 * conversation belongs to at most one problem. The link is written only by
 * `desk-problems.ts`, which puts `problem_linked` / `problem_unlinked` on the
 * conversation's timeline.
 *
 * rootCause / workaround / resolution are free text. A problem is a known
 * error from the moment its status is `known_error` (`knownErrorAt`), and
 * stays one in the list after it is resolved: the workaround is what agents
 * look up while incidents keep coming in.
 *
 * articleId: the help-center article written from this problem, when there
 * is one (helpdesk_articles).
 */
export const deskProblems = pgTable(
  'desk_problems',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    problemNumber: integer('problem_number').notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),

    status: varchar('status', { length: 20 }).$type<DeskProblemStatus>().notNull().default('open'),
    priority: varchar('priority', { length: 10 }).$type<DeskPriority>(),

    rootCause: text('root_cause'),
    workaround: text('workaround'),
    resolution: text('resolution'),

    /** The member who owns the investigation (a user id). */
    assigneeId: varchar('assignee_id', { length: 255 }),
    /** The team (helpdesk_departments). */
    departmentId: varchar('department_id', { length: 30 }),

    articleId: varchar('article_id', { length: 30 }),

    knownErrorAt: timestamp('known_error_at'),
    resolvedAt: timestamp('resolved_at'),
    closedAt: timestamp('closed_at'),

    createdById: varchar('created_by_id', { length: 255 }),
  },
  (table) => [
    uniqueIndex('desk_problems_number_uidx').on(table.problemNumber),
    index('desk_problems_status_idx').on(table.status, table.updatedAt),
    index('desk_problems_assignee_idx').on(table.assigneeId, table.status),
    index('desk_problems_known_error_idx')
      .on(table.knownErrorAt)
      .where(sql`${table.knownErrorAt} IS NOT NULL`),
  ],
);

export type DeskProblem = typeof deskProblems.$inferSelect;
export type NewDeskProblem = typeof deskProblems.$inferInsert;
