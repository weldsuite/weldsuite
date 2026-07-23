import {
  pgTable,
  varchar,
  timestamp,
  bigint,
  integer,
  index,
} from 'drizzle-orm/pg-core';

export const workspaceStorage = pgTable('workspace_storage', {
  id: varchar('id', { length: 30 }).primaryKey(),
  workspaceId: varchar('workspace_id', { length: 255 }).notNull().unique(),

  // Usage tracking
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
  fileCount: integer('file_count').notNull().default(0),

  // Quotas (10 GB = 10737418240, 100 MB = 104857600)
  quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(10737418240),
  maxFileSize: bigint('max_file_size', { mode: 'number' }).notNull().default(104857600),
  maxFileCount: integer('max_file_count').notNull().default(10000),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('workspace_storage_workspace_idx').on(table.workspaceId),
]);

export type WorkspaceStorage = typeof workspaceStorage.$inferSelect;
export type NewWorkspaceStorage = typeof workspaceStorage.$inferInsert;
