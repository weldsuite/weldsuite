import {
  pgTable,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const taskTags = pgTable('task_tags', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Owner
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Basic info
  name: varchar('name', { length: 100 }).notNull(),
  color: varchar('color', { length: 50 }),
}, (table) => [
  index('task_tags_user_idx').on(table.userId),
]);

export type TaskTag = typeof taskTags.$inferSelect;
export type NewTaskTag = typeof taskTags.$inferInsert;
