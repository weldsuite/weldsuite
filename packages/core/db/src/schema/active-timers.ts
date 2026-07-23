import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { tasks } from './tasks';

/**
 * A timer that is currently running. Exactly one row per user at a time --
 * stopping a timer deletes the row and writes a completed `time_entries` row,
 * so every row in `time_entries` stays a finished entry with a non-null duration.
 */
export const activeTimers = pgTable('active_timers', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // References
  projectId: varchar('project_id', { length: 255 }).references(() => projects.id),
  taskId: varchar('task_id', { length: 255 }).references(() => tasks.id),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Time
  startedAt: timestamp('started_at').notNull().defaultNow(),

  // Description
  description: text('description'),
  activity: varchar('activity', { length: 100 }),

  // Billing -- carried over to the time entry on stop
  billable: boolean('billable').notNull().default(true),
  rate: numeric('rate', { precision: 10, scale: 2 }),
}, (table) => [
  uniqueIndex('active_timers_user_idx').on(table.userId),
  index('active_timers_project_idx').on(table.projectId),
  index('active_timers_task_idx').on(table.taskId),
]);

export type ActiveTimer = typeof activeTimers.$inferSelect;
export type NewActiveTimer = typeof activeTimers.$inferInsert;
