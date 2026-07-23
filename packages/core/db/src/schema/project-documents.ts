import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';

// Document content types
export type DocumentContentType = 'html' | 'markdown' | 'json';

// Document page structure for multi-page documents
export interface DocumentPageData {
  id: string;
  title: string;
  content: string;
  coverImage?: string;
  createdAt: string;
  updatedAt: string;
}

export const projectDocuments = pgTable('project_documents', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Reference
  projectId: varchar('project_id', { length: 255 }).notNull().references(() => projects.id),

  // Document info
  title: varchar('title', { length: 500 }).notNull().default('Untitled'),
  content: text('content'),
  contentType: varchar('content_type', { length: 50 }).notNull().default('json'),

  // Multi-page support
  pages: jsonb('pages').$type<DocumentPageData[]>(),
  activePageId: varchar('active_page_id', { length: 255 }),

  // Hierarchy (nested documents)
  parentId: varchar('parent_id', { length: 255 }),
  position: integer('position').notNull().default(0),

  // Block editor content (BlockNote JSON)
  contentJson: jsonb('content_json').$type<Record<string, unknown>[]>(),

  // Visual
  coverImage: varchar('cover_image', { length: 1000 }),
  icon: varchar('icon', { length: 100 }),

  // Publishing
  isPublished: boolean('is_published').notNull().default(false),
  publishedAt: timestamp('published_at'),

  // Editing info
  lastEditedBy: varchar('last_edited_by', { length: 255 }),
}, (table) => [
  index('project_documents_project_idx').on(table.projectId),
  index('project_documents_published_idx').on(table.isPublished),
  index('project_documents_parent_idx').on(table.parentId),
  index('project_documents_parent_position_idx').on(table.parentId, table.position),
]);

export type ProjectDocument = typeof projectDocuments.$inferSelect;
export type NewProjectDocument = typeof projectDocuments.$inferInsert;
