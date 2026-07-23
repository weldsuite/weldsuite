import {
  pgTable,
  varchar,
  timestamp,
  integer,
  bigint,
  real,
  pgEnum,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { socialPosts } from './social-posts';
import { socialAccounts } from './social-accounts';

// Snapshot period enum
export const socialAnalyticsSnapshotPeriodEnum = pgEnum('social_analytics_snapshot_period', [
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'lifetime',
]);

// Engagement breakdown interface
export interface SocialEngagementBreakdown {
  reactions?: {
    like?: number;
    love?: number;
    haha?: number;
    wow?: number;
    sad?: number;
    angry?: number;
  };
  shareTypes?: {
    share?: number;
    retweet?: number;
    repost?: number;
    quote?: number;
  };
  commentSentiment?: {
    positive?: number;
    neutral?: number;
    negative?: number;
  };
}

// Audience demographics interface
export interface SocialAudienceDemographics {
  ageGroups?: Record<string, number>;
  genders?: Record<string, number>;
  topCountries?: { country: string; count: number }[];
  topCities?: { city: string; count: number }[];
}

// Reach breakdown interface
export interface SocialReachBreakdown {
  organic?: number;
  paid?: number;
  viral?: number;
  followers?: number;
  nonFollowers?: number;
}

// Video analytics interface
export interface SocialVideoAnalytics {
  totalWatchTime?: number;
  averageWatchTime?: number;
  completionRate?: number;
  threeSecondViews?: number;
  tenSecondViews?: number;
  thirtySecondViews?: number;
}

// Click breakdown interface
export interface SocialClickBreakdown {
  linkClicks?: number;
  profileClicks?: number;
  mediaClicks?: number;
  hashtagClicks?: number;
  mentionClicks?: number;
}

export const socialAnalytics = pgTable('social_analytics', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // References
  postId: varchar('post_id', { length: 30 }).notNull().references(() => socialPosts.id),
  accountId: varchar('account_id', { length: 30 }).notNull().references(() => socialAccounts.id),
  platformPostId: varchar('platform_post_id', { length: 255 }),

  // Snapshot info
  snapshotPeriod: socialAnalyticsSnapshotPeriodEnum('snapshot_period').notNull().default('lifetime'),
  snapshotAt: timestamp('snapshot_at').notNull(),

  // Core engagement metrics
  impressions: bigint('impressions', { mode: 'number' }).default(0),
  reach: bigint('reach', { mode: 'number' }).default(0),

  // Engagement counts
  likes: integer('likes').default(0),
  comments: integer('comments').default(0),
  shares: integer('shares').default(0),
  saves: integer('saves').default(0),

  // Video-specific
  videoViews: integer('video_views').default(0),
  videoAnalytics: jsonb('video_analytics').$type<SocialVideoAnalytics>(),

  // Clicks
  clicks: integer('clicks').default(0),
  clickBreakdown: jsonb('click_breakdown').$type<SocialClickBreakdown>(),

  // Calculated rates
  engagementRate: real('engagement_rate'),
  clickThroughRate: real('click_through_rate'),

  // Total engagement (likes + comments + shares + saves)
  totalEngagement: integer('total_engagement').default(0),

  // Engagement breakdown (reactions, share types, etc.)
  engagementBreakdown: jsonb('engagement_breakdown').$type<SocialEngagementBreakdown>(),

  // Reach breakdown
  reachBreakdown: jsonb('reach_breakdown').$type<SocialReachBreakdown>(),

  // Audience info
  audienceDemographics: jsonb('audience_demographics').$type<SocialAudienceDemographics>(),

  // Follows gained from this post
  followsFromPost: integer('follows_from_post').default(0),

  // Profile actions
  profileVisits: integer('profile_visits').default(0),

  // Story-specific metrics
  storyReplies: integer('story_replies'),
  storyExits: integer('story_exits'),
  storyTapsForward: integer('story_taps_forward'),
  storyTapsBack: integer('story_taps_back'),

  // Hashtag performance
  hashtagReach: jsonb('hashtag_reach').$type<Record<string, number>>(),

  // Best performing time analysis
  peakEngagementHour: integer('peak_engagement_hour'),

  // Raw API response (for debugging/future fields)
  rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
}, (table) => [
  index('social_analytics_post_idx').on(table.postId),
  index('social_analytics_account_idx').on(table.accountId),
  index('social_analytics_snapshot_at_idx').on(table.snapshotAt),
  index('social_analytics_period_idx').on(table.snapshotPeriod),
  unique('social_analytics_unique_snapshot').on(
    table.postId,
    table.accountId,
    table.snapshotPeriod,
    table.snapshotAt
  ),
]);

export type SocialAnalytics = typeof socialAnalytics.$inferSelect;
export type NewSocialAnalytics = typeof socialAnalytics.$inferInsert;
