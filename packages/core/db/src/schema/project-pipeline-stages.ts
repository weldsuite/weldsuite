import {
  pgTable,
  varchar,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';

export const projectPipelineStages = pgTable('project_pipeline_stages', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  projectId: varchar('project_id', { length: 30 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  color: varchar('color', { length: 50 }),
  position: integer('position').notNull().default(0),
  // The canonical system-wide status this stage maps to (used by list/gantt/analytics views)
  systemStatus: varchar('system_status', { length: 50 }).notNull().default('in_progress'),
}, (table) => [
  index('project_pipeline_stages_project_id_idx').on(table.projectId),
  index('project_pipeline_stages_position_idx').on(table.position),
]);

export type ProjectPipelineStage = typeof projectPipelineStages.$inferSelect;
export type NewProjectPipelineStage = typeof projectPipelineStages.$inferInsert;
