import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export type TaskImportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TaskImportError {
  row: number;
  title: string;
  error: string;
}

export const taskImportJobs = pgTable('task_import_jobs', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),

  workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  projectId: varchar('project_id', { length: 255 }).notNull(),

  r2Key: varchar('r2_key', { length: 500 }).notNull(),
  workflowInstanceId: varchar('workflow_instance_id', { length: 255 }),

  status: varchar('status', { length: 20 }).notNull().default('queued'),

  total: integer('total').notNull().default(0),
  processed: integer('processed').notNull().default(0),
  imported: integer('imported').notNull().default(0),
  updated: integer('updated').notNull().default(0),
  failed: integer('failed').notNull().default(0),

  errors: jsonb('errors').$type<TaskImportError[]>().default([]),
  errorMessage: varchar('error_message', { length: 1000 }),
}, (table) => [
  index('task_import_jobs_workspace_idx').on(table.workspaceId),
  index('task_import_jobs_project_idx').on(table.projectId),
  index('task_import_jobs_status_idx').on(table.status),
  index('task_import_jobs_created_idx').on(table.createdAt),
]);

export type TaskImportJob = typeof taskImportJobs.$inferSelect;
export type NewTaskImportJob = typeof taskImportJobs.$inferInsert;
