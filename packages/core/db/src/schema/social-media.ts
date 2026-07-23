import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Media type enum
export const socialMediaTypeEnum = pgEnum('social_media_type', [
  'image',
  'video',
  'gif',
]);

// Media status enum
export const socialMediaStatusEnum = pgEnum('social_media_status', [
  'uploading',
  'processing',
  'ready',
  'error',
  'deleted',
]);

// Media dimensions interface
export interface SocialMediaDimensions {
  width: number;
  height: number;
  aspectRatio?: string;
}

// Video metadata interface
export interface SocialVideoMetadata {
  duration?: number;
  bitrate?: number;
  codec?: string;
  frameRate?: number;
  hasAudio?: boolean;
}

// Thumbnail info interface
export interface SocialThumbnailInfo {
  url: string;
  width: number;
  height: number;
  generatedAt: string;
}

// Platform compatibility
export interface SocialPlatformCompatibility {
  facebook?: boolean;
  instagram?: boolean;
  twitter?: boolean;
  linkedin?: boolean;
  tiktok?: boolean;
}

export const socialMedia = pgTable('social_media', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // File info
  fileName: varchar('file_name', { length: 500 }).notNull(),
  originalName: varchar('original_name', { length: 500 }),
  mimeType: varchar('mime_type', { length: 255 }).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),

  // Media type
  mediaType: socialMediaTypeEnum('media_type').notNull(),

  // Storage
  storagePath: varchar('storage_path', { length: 1000 }).notNull(),
  fileKey: varchar('file_key', { length: 1000 }),
  bucket: varchar('bucket', { length: 255 }),
  url: varchar('url', { length: 1000 }),
  storageProvider: varchar('storage_provider', { length: 50 }).notNull().default('r2'),

  // Thumbnails
  thumbnailUrl: varchar('thumbnail_url', { length: 1000 }),
  thumbnails: jsonb('thumbnails').$type<SocialThumbnailInfo[]>(),

  // Dimensions
  dimensions: jsonb('dimensions').$type<SocialMediaDimensions>(),

  // Video-specific
  videoMetadata: jsonb('video_metadata').$type<SocialVideoMetadata>(),

  // Processing status
  status: socialMediaStatusEnum('status').notNull().default('uploading'),
  processingError: text('processing_error'),
  processedAt: timestamp('processed_at'),

  // Upload info
  uploadedByUserId: varchar('uploaded_by_user_id', { length: 255 }).notNull(),

  // Organization
  folderId: varchar('folder_id', { length: 30 }),
  tags: jsonb('tags').$type<string[]>(),

  // Alt text for accessibility
  altText: text('alt_text'),
  description: text('description'),

  // Usage tracking
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at'),

  // Platform compatibility
  platformCompatibility: jsonb('platform_compatibility').$type<SocialPlatformCompatibility>(),

  // Checksum for deduplication
  checksum: varchar('checksum', { length: 64 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('social_media_type_idx').on(table.mediaType),
  index('social_media_status_idx').on(table.status),
  index('social_media_folder_idx').on(table.folderId),
  index('social_media_uploaded_by_idx').on(table.uploadedByUserId),
  index('social_media_checksum_idx').on(table.checksum),
]);

export type SocialMedia = typeof socialMedia.$inferSelect;
export type NewSocialMedia = typeof socialMedia.$inferInsert;
