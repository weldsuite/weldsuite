import {
  pgTable,
  varchar,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const taskProjects = pgTable('task_projects', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Owner
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  color: varchar('color', { length: 50 }),
}, (table) => [
  index('task_projects_user_idx').on(table.userId),
]);

export type TaskProject = typeof taskProjects.$inferSelect;
export type NewTaskProject = typeof taskProjects.$inferInsert;
