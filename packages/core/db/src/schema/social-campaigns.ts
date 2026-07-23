import {
  pgTable,
  varchar,
  text,
  timestamp,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// Campaign status enum
export const socialCampaignStatusEnum = pgEnum('social_campaign_status', [
  'draft',
  'active',
  'paused',
  'completed',
  'archived',
]);

// Campaign goals interface
export interface SocialCampaignGoals {
  impressions?: number;
  reach?: number;
  engagement?: number;
  clicks?: number;
  followers?: number;
  conversions?: number;
}

// Campaign performance interface
export interface SocialCampaignPerformance {
  totalPosts?: number;
  publishedPosts?: number;
  totalImpressions?: number;
  totalReach?: number;
  totalEngagement?: number;
  totalClicks?: number;
  averageEngagementRate?: number;
}

export const socialCampaigns = pgTable('social_campaigns', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Campaign info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  color: varchar('color', { length: 20 }),

  // Status
  status: socialCampaignStatusEnum('status').notNull().default('draft'),

  // Schedule
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),

  // Target accounts
  targetAccountIds: jsonb('target_account_ids').$type<string[]>(),

  // Goals
  goals: jsonb('goals').$type<SocialCampaignGoals>(),

  // Performance (aggregated)
  performance: jsonb('performance').$type<SocialCampaignPerformance>(),

  // Organization
  tags: jsonb('tags').$type<string[]>(),
  labels: jsonb('labels').$type<string[]>(),

  // Author
  createdByUserId: varchar('created_by_user_id', { length: 255 }).notNull(),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('social_campaigns_status_idx').on(table.status),
  index('social_campaigns_start_date_idx').on(table.startDate),
  index('social_campaigns_end_date_idx').on(table.endDate),
  index('social_campaigns_created_by_idx').on(table.createdByUserId),
]);

export type SocialCampaign = typeof socialCampaigns.$inferSelect;
export type NewSocialCampaign = typeof socialCampaigns.$inferInsert;
