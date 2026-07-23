import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';

// File types
export type FileType = 'folder' | 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'archive' | 'code' | 'file';

export const projectFiles = pgTable('project_files', {
  // BaseEntity fields
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Reference
  projectId: varchar('project_id', { length: 255 }).references(() => projects.id),

  // File info
  fileName: varchar('file_name', { length: 500 }).notNull(),
  originalName: varchar('original_name', { length: 500 }),
  mimeType: varchar('mime_type', { length: 255 }).notNull(),
  fileSize: integer('file_size').notNull(),

  // Storage
  storagePath: varchar('storage_path', { length: 1000 }).notNull(),
  fileKey: varchar('file_key', { length: 1000 }),
  bucket: varchar('bucket', { length: 255 }),
  url: varchar('url', { length: 1000 }),
  thumbnailUrl: varchar('thumbnail_url', { length: 1000 }),
  storageProvider: varchar('storage_provider', { length: 50 }).notNull().default('r2'),

  // Upload info
  uploadedById: varchar('uploaded_by_id', { length: 255 }),

  // File type
  fileType: varchar('file_type', { length: 50 }).notNull().default('file'),
  isFolder: boolean('is_folder').notNull().default(false),

  // Visibility
  isPublic: boolean('is_public').notNull().default(false),
  expiresAt: timestamp('expires_at'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('project_files_project_idx').on(table.projectId),
  index('project_files_uploaded_by_idx').on(table.uploadedById),
  index('project_files_file_type_idx').on(table.fileType),
]);

export type ProjectFile = typeof projectFiles.$inferSelect;
export type NewProjectFile = typeof projectFiles.$inferInsert;
