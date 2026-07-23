import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { folders } from './folders';

export const files = pgTable('files', {
  id: varchar('id', { length: 255 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // File info
  fileName: varchar('file_name', { length: 500 }).notNull(),
  originalName: varchar('original_name', { length: 500 }),
  mimeType: varchar('mime_type', { length: 255 }).notNull(),
  fileSize: integer('file_size').notNull(),
  fileType: varchar('file_type', { length: 50 }).notNull().default('file'),

  // Storage (R2)
  storagePath: varchar('storage_path', { length: 1000 }).notNull(),
  fileKey: varchar('file_key', { length: 1000 }),
  bucket: varchar('bucket', { length: 255 }),
  url: varchar('url', { length: 1000 }),
  thumbnailUrl: varchar('thumbnail_url', { length: 1000 }),
  storageProvider: varchar('storage_provider', { length: 50 }).notNull().default('r2'),

  // Organization
  folderId: varchar('folder_id', { length: 255 }).references(() => folders.id),

  // Ownership
  uploadedById: varchar('uploaded_by_id', { length: 255 }),

  // Visibility & flags
  isPublic: boolean('is_public').notNull().default(false),
  isStarred: boolean('is_starred').notNull().default(false),

  // Pinning — workspace-wide, unlike isStarred which reads as a personal flag.
  // A pinned file sorts above everything else in its surface (WeldFlow docs).
  isPinned: boolean('is_pinned').notNull().default(false),
  pinnedAt: timestamp('pinned_at'),
  pinnedBy: varchar('pinned_by', { length: 255 }),

  // Source entity reference — links file back to its originating module/record
  entityType: varchar('entity_type', { length: 100 }),
  entityId: varchar('entity_id', { length: 255 }),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('files_folder_idx').on(table.folderId),
  index('files_uploaded_by_idx').on(table.uploadedById),
  index('files_file_type_idx').on(table.fileType),
  index('files_entity_idx').on(table.entityType, table.entityId),
  index('files_is_pinned_idx').on(table.isPinned),
]);

export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
