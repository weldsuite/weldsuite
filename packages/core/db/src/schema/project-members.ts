import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  numeric,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';

// Project roles matching backend
export type ProjectRole = 'owner' | 'admin' | 'member' | 'viewer';

export const projectMembers = pgTable('project_members', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // References
  projectId: varchar('project_id', { length: 255 }).notNull().references(() => projects.id),
  userId: varchar('user_id', { length: 255 }).notNull(),

  // Role & Permissions
  role: varchar('role', { length: 50 }).notNull().default('member'),
  permissions: jsonb('permissions').$type<string[]>(),

  // Status
  isActive: boolean('is_active').notNull().default(true),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
  leftAt: timestamp('left_at'),

  // Allocation & Rate
  allocationPercentage: numeric('allocation_percentage', { precision: 5, scale: 2 }),
  hourlyRate: numeric('hourly_rate', { precision: 10, scale: 2 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  unique('project_members_unique').on(table.projectId, table.userId),
  index('project_members_project_idx').on(table.projectId),
  index('project_members_user_idx').on(table.userId),
  index('project_members_role_idx').on(table.role),
]);

export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
