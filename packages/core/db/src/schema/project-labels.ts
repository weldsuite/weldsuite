import {
  pgTable,
  varchar,
  timestamp,
} from 'drizzle-orm/pg-core';

export const projectLabels = pgTable('project_labels', {
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Nullable: legacy labels created before per-project scoping have NULL projectId
  // and are visible across all projects. New labels created from a project's
  // settings have projectId set and are scoped to that project only.
  projectId: varchar('project_id', { length: 255 }),

  name: varchar('name', { length: 100 }).notNull(),
  color: varchar('color', { length: 50 }).notNull(),
});

export type ProjectLabel = typeof projectLabels.$inferSelect;
export type NewProjectLabel = typeof projectLabels.$inferInsert;
