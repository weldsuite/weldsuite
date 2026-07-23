import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  numeric,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';

// Milestone status matching backend
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'missed' | 'postponed';

export const milestones = pgTable('milestones', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Reference
  projectId: varchar('project_id', { length: 255 }).notNull().references(() => projects.id),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Dates
  dueDate: timestamp('due_date').notNull(),
  completedAt: timestamp('completed_at'),

  // Status
  status: varchar('status', { length: 50 }).notNull().default('pending'),

  // Progress
  progress: numeric('progress', { precision: 5, scale: 2 }).notNull().default('0'),
  completedTasks: integer('completed_tasks').default(0),
  totalTasks: integer('total_tasks').default(0),

  // Deliverables
  deliverables: jsonb('deliverables').$type<string[]>(),

  // Dependencies
  dependsOn: jsonb('depends_on').$type<string[]>(),

  // Owner
  ownerId: varchar('owner_id', { length: 255 }),
  responsible: jsonb('responsible').$type<string[]>(),

  // Metadata
  tags: jsonb('tags').$type<string[]>(),
  isKeyMilestone: boolean('is_key_milestone').default(false),
}, (table) => [
  index('milestones_project_idx').on(table.projectId),
  index('milestones_status_idx').on(table.status),
  index('milestones_due_date_idx').on(table.dueDate),
]);

export type Milestone = typeof milestones.$inferSelect;
export type NewMilestone = typeof milestones.$inferInsert;
