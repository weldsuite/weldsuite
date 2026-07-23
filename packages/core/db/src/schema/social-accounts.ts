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
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Platform enum
export const socialPlatformEnum = pgEnum('social_platform', [
  'facebook',
  'instagram',
  'twitter',
  'linkedin',
  'tiktok',
]);

// Account status enum
export const socialAccountStatusEnum = pgEnum('social_account_status', [
  'active',
  'inactive',
  'expired',
  'error',
  'pending_reauth',
]);

// Account type enum
export const socialAccountTypeEnum = pgEnum('social_account_type', [
  'business',
  'creator',
  'personal',
]);

// Platform-specific settings interface
export interface SocialPlatformSettings {
  // Meta-specific
  pageId?: string;
  instagramBusinessAccountId?: string;
  // LinkedIn-specific
  organizationId?: string;
  // TikTok-specific
  openId?: string;
  // Twitter/X-specific
  listIds?: string[];
}

// API rate limit tracking
export interface SocialRateLimits {
  requestsRemaining?: number;
  resetAt?: string;
  dailyLimit?: number;
  usedToday?: number;
}

export const socialAccounts = pgTable('social_accounts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Platform identification
  platform: socialPlatformEnum('platform').notNull(),
  platformAccountId: varchar('platform_account_id', { length: 255 }).notNull(),

  // PostPeer unified provider mapping. PostPeer holds the platform OAuth tokens;
  // we only keep the integration + profile ids it returns. The legacy
  // accessToken/refreshToken columns below are unused when connected via PostPeer.
  postpeerIntegrationId: varchar('postpeer_integration_id', { length: 255 }),
  postpeerProfileId: varchar('postpeer_profile_id', { length: 255 }),

  // Account info (cached from platform)
  name: varchar('name', { length: 255 }).notNull(),
  username: varchar('username', { length: 255 }),
  profileUrl: varchar('profile_url', { length: 1000 }),
  avatarUrl: varchar('avatar_url', { length: 1000 }),
  accountType: socialAccountTypeEnum('account_type').default('business'),

  // OAuth tokens (encrypted at rest)
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at'),

  // Permissions/scopes granted
  scopes: jsonb('scopes').$type<string[]>(),

  // Platform-specific settings
  platformSettings: jsonb('platform_settings').$type<SocialPlatformSettings>(),

  // Status
  status: socialAccountStatusEnum('status').notNull().default('active'),
  lastSyncAt: timestamp('last_sync_at'),
  lastError: text('last_error'),
  errorCount: integer('error_count').default(0),

  // Rate limits tracking
  rateLimits: jsonb('rate_limits').$type<SocialRateLimits>(),

  // Follower stats (cached)
  followerCount: integer('follower_count'),
  followingCount: integer('following_count'),
  postCount: integer('post_count'),
  statsUpdatedAt: timestamp('stats_updated_at'),

  // Connected by
  connectedByUserId: varchar('connected_by_user_id', { length: 255 }).notNull(),

  // Settings
  isDefault: boolean('is_default').default(false),
  autoPublish: boolean('auto_publish').default(true),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('social_accounts_platform_idx').on(table.platform),
  index('social_accounts_status_idx').on(table.status),
  index('social_accounts_postpeer_integration_idx').on(table.postpeerIntegrationId),
  uniqueIndex('social_accounts_platform_account_idx').on(
    table.platform,
    table.platformAccountId
  ),
]);

export type SocialAccount = typeof socialAccounts.$inferSelect;
export type NewSocialAccount = typeof socialAccounts.$inferInsert;
