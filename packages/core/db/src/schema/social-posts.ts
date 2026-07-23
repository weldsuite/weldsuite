import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Post status enum (workflow states)
export const socialPostStatusEnum = pgEnum('social_post_status', [
  'draft',
  'pending_approval',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled',
]);

// Post type enum
export const socialPostTypeEnum = pgEnum('social_post_type', [
  'post',
  'story',
  'reel',
  'thread',
  'carousel',
  'poll',
]);

// Platform-specific content interface
export interface SocialPlatformContent {
  platform: 'facebook' | 'instagram' | 'twitter' | 'linkedin' | 'tiktok';
  accountId: string;
  content?: string;
  mediaIds?: string[];
  platformPostId?: string;
  publishedUrl?: string;
  status?: 'pending' | 'published' | 'failed';
  error?: string;
  publishedAt?: string;
}

// Hashtag settings interface
export interface SocialHashtagSettings {
  hashtags: string[];
  position: 'inline' | 'end' | 'first_comment';
  autoGenerate?: boolean;
}

// Link settings interface
export interface SocialLinkSettings {
  url?: string;
  shortenUrl?: boolean;
  shortUrl?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

// Poll configuration interface
export interface SocialPollConfig {
  question: string;
  options: string[];
  durationMinutes?: number;
  multipleChoice?: boolean;
}

// Location data interface
export interface SocialLocationData {
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
}

// First comment config
export interface SocialFirstCommentConfig {
  enabled: boolean;
  content?: string;
  delay?: number;
}

export const socialPosts = pgTable('social_posts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic content
  title: varchar('title', { length: 255 }),
  content: text('content').notNull(),

  // Post type
  postType: socialPostTypeEnum('post_type').notNull().default('post'),

  // Workflow status
  status: socialPostStatusEnum('status').notNull().default('draft'),

  // Target platforms and accounts
  targetAccountIds: jsonb('target_account_ids').$type<string[]>().notNull(),
  platformContent: jsonb('platform_content').$type<SocialPlatformContent[]>(),

  // Media
  mediaIds: jsonb('media_ids').$type<string[]>(),

  // Scheduling
  scheduledAt: timestamp('scheduled_at'),
  publishedAt: timestamp('published_at'),
  timezone: varchar('timezone', { length: 50 }).default('UTC'),

  // Queue position for same-time posts
  queuePosition: integer('queue_position'),

  // Hashtags
  hashtagSettings: jsonb('hashtag_settings').$type<SocialHashtagSettings>(),

  // Links
  linkSettings: jsonb('link_settings').$type<SocialLinkSettings>(),

  // Poll (for supported platforms)
  pollConfig: jsonb('poll_config').$type<SocialPollConfig>(),

  // Location tagging
  location: jsonb('location').$type<SocialLocationData>(),

  // First comment
  firstComment: jsonb('first_comment').$type<SocialFirstCommentConfig>(),

  // Mentions/Tags
  mentions: jsonb('mentions').$type<string[]>(),

  // Author
  createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),
  lastEditedByUserId: varchar('last_edited_by_user_id', { length: 255 }),

  // Approval workflow
  approvalRequestedAt: timestamp('approval_requested_at'),
  approvedAt: timestamp('approved_at'),
  approvedByUserId: varchar('approved_by_user_id', { length: 255 }),
  rejectedAt: timestamp('rejected_at'),
  rejectedByUserId: varchar('rejected_by_user_id', { length: 255 }),
  rejectionReason: text('rejection_reason'),

  // Publishing
  publishAttempts: integer('publish_attempts').default(0),
  lastPublishError: text('last_publish_error'),
  lastPublishAttemptAt: timestamp('last_publish_attempt_at'),

  // Credit metering — credits charged for the current submission (per target
  // platform) and the master-DB ledger transaction that recorded it. Used for
  // refunds on failure/cancel. Mirrors voipCalls.creditsConsumed.
  creditsConsumed: integer('credits_consumed').default(0),
  creditTransactionId: varchar('credit_transaction_id', { length: 30 }),

  // PostPeer unified provider mapping — the post id returned by PostPeer once
  // the post is created/scheduled. Used to reconcile status from webhooks.
  postpeerPostId: varchar('postpeer_post_id', { length: 255 }),

  // Content calendar
  calendarColor: varchar('calendar_color', { length: 20 }),
  campaignId: varchar('campaign_id', { length: 30 }),

  // Organization
  labels: jsonb('labels').$type<string[]>(),
  tags: jsonb('tags').$type<string[]>(),

  // Notes (internal, not published)
  internalNotes: text('internal_notes'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('social_posts_status_idx').on(table.status),
  index('social_posts_scheduled_at_idx').on(table.scheduledAt),
  index('social_posts_published_at_idx').on(table.publishedAt),
  index('social_posts_created_by_idx').on(table.createdByUserId),
  index('social_posts_campaign_idx').on(table.campaignId),
  index('social_posts_post_type_idx').on(table.postType),
  index('social_posts_postpeer_post_idx').on(table.postpeerPostId),
]);

export type SocialPost = typeof socialPosts.$inferSelect;
export type NewSocialPost = typeof socialPosts.$inferInsert;
