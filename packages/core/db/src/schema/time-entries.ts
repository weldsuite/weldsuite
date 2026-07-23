import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  numeric,
  date,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { tasks } from './tasks';

// Time entry status matching backend
export type TimeEntryStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'billed';

export const timeEntries = pgTable('time_entries', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // References
  projectId: varchar('project_id', { length: 255 }).references(() => projects.id),
  taskId: varchar('task_id', { length: 255 }).references(() => tasks.id),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Time
  date: date('date').notNull(),
  startTime: timestamp('start_time'),
  endTime: timestamp('end_time'),
  duration: numeric('duration', { precision: 10, scale: 2 }).notNull(), // minutes

  // Description
  description: text('description'),
  activity: varchar('activity', { length: 100 }),

  // Billing
  billable: boolean('billable').notNull().default(true),
  rate: numeric('rate', { precision: 10, scale: 2 }),
  cost: numeric('cost', { precision: 10, scale: 2 }),

  // Status
  status: varchar('status', { length: 50 }).notNull().default('draft'),
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),

  // Location
  location: varchar('location', { length: 255 }),
  isRemote: boolean('is_remote').default(false),
}, (table) => [
  index('time_entries_project_idx').on(table.projectId),
  index('time_entries_task_idx').on(table.taskId),
  index('time_entries_user_idx').on(table.userId),
  index('time_entries_date_idx').on(table.date),
  index('time_entries_status_idx').on(table.status),
]);

export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
