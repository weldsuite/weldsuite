import {
  pgTable,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';

export const projectWhiteboards = pgTable('project_whiteboards', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Reference
  projectId: varchar('project_id', { length: 255 }).notNull().references(() => projects.id),

  // Whiteboard info
  name: varchar('name', { length: 255 }).notNull().default('Main Whiteboard'),

  // Canvas data (Excalidraw compatible)
  elements: jsonb('elements').$type<unknown[]>(),
  appState: jsonb('app_state').$type<Record<string, unknown>>(),

  // Versioning
  version: integer('version').notNull().default(1),

  // Editing info
  lastEditedBy: varchar('last_edited_by', { length: 255 }),
}, (table) => [
  index('project_whiteboards_project_idx').on(table.projectId),
]);

export type ProjectWhiteboard = typeof projectWhiteboards.$inferSelect;
export type NewProjectWhiteboard = typeof projectWhiteboards.$inferInsert;
