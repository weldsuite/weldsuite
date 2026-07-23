import {
  pgTable,
  varchar,
  boolean,
  integer,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';

export interface TaskDigestTaskTypes {
  projectTasks: boolean;
  personalTasks: boolean;
}

export interface TaskDigestSections {
  overdue: boolean;
  dueToday: boolean;
  dueThisWeek: boolean;
}

export const taskDigestSettings = pgTable('task_digest_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Master toggle
  enabled: boolean('enabled').notNull().default(true),

  // Hour (0-23) in workspace timezone
  sendHour: integer('send_hour').notNull().default(8),

  // Which task types to include
  taskTypes: jsonb('task_types').$type<TaskDigestTaskTypes>().notNull().default({
    projectTasks: true,
    personalTasks: true,
  }),

  // Which sections to include
  sections: jsonb('sections').$type<TaskDigestSections>().notNull().default({
    overdue: true,
    dueToday: true,
    dueThisWeek: true,
  }),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TaskDigestSetting = typeof taskDigestSettings.$inferSelect;
export type NewTaskDigestSetting = typeof taskDigestSettings.$inferInsert;
