import {
  pgTable,
  varchar,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const taskComments = pgTable('task_comments', {
  id: varchar('id', { length: 255 }).primaryKey(),
  taskId: varchar('task_id', { length: 255 }).notNull(),
  taskType: varchar('task_type', { length: 20 }).notNull(), // 'project' or 'personal'
  content: text('content').notNull(),
  authorId: varchar('author_id', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('task_comments_task_idx').on(table.taskId),
  index('task_comments_author_idx').on(table.authorId),
  index('task_comments_created_idx').on(table.createdAt),
]);

export type TaskComment = typeof taskComments.$inferSelect;
export type NewTaskComment = typeof taskComments.$inferInsert;
