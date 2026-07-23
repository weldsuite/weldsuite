import { pgTable, varchar, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects';

// Project goals - stores mission and goals canvas data per project
export const projectGoals = pgTable('project_goals', {
  id: varchar('id', { length: 30 }).primaryKey(),
  projectId: varchar('project_id', { length: 30 })
    .notNull()
    .references(() => projects.id),
  mission: jsonb('mission').$type<Record<string, unknown>>(), // Mission card data
  goals: jsonb('goals').$type<unknown[]>().default([]), // Array of goal cards
  lastEditedBy: varchar('last_edited_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type ProjectGoal = typeof projectGoals.$inferSelect;
export type NewProjectGoal = typeof projectGoals.$inferInsert;
