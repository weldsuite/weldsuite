import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';

// Sprint status matching backend
export type SprintStatus = 'planned' | 'active' | 'completed' | 'cancelled';

export const sprints = pgTable('sprints', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Reference
  projectId: varchar('project_id', { length: 255 }).notNull().references(() => projects.id),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  goal: text('goal'),

  // Status
  status: varchar('status', { length: 50 }).notNull().default('planned'),

  // Dates
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),

  // Metrics
  velocity: integer('velocity'),
  storyPointsCommitted: integer('story_points_committed'),
  storyPointsCompleted: integer('story_points_completed'),
}, (table) => [
  index('sprints_project_idx').on(table.projectId),
  index('sprints_status_idx').on(table.status),
  index('sprints_start_date_idx').on(table.startDate),
]);

export type Sprint = typeof sprints.$inferSelect;
export type NewSprint = typeof sprints.$inferInsert;
