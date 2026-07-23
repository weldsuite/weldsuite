import {
  pgTable,
  varchar,
  timestamp,
  bigint,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const pendingUploads = pgTable('pending_uploads', {
  // Upload token serves as the primary key
  id: varchar('id', { length: 64 }).primaryKey(),

  // User context
  userId: varchar('user_id', { length: 255 }).notNull(),

  // File information
  fileName: varchar('file_name', { length: 500 }).notNull(),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),

  // Storage information
  fileKey: varchar('file_key', { length: 1000 }).notNull(),
  bucket: varchar('bucket', { length: 255 }).notNull(),
  folder: varchar('folder', { length: 255 }),

  // Entity association (optional - for linking to projects, products, etc.)
  entityType: varchar('entity_type', { length: 100 }),
  entityId: varchar('entity_id', { length: 255 }),

  // Visibility
  isPublic: boolean('is_public').notNull().default(false),

  // Additional metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Expiration (default 1 hour from creation)
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('pending_uploads_user_idx').on(table.userId),
  index('pending_uploads_expires_idx').on(table.expiresAt),
]);

export type PendingUpload = typeof pendingUploads.$inferSelect;
export type NewPendingUpload = typeof pendingUploads.$inferInsert;
