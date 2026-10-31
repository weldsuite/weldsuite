import { z } from 'zod';

// ============================================================================
// WeldSocial (social-api) response shapes, matching the interfaces of
// `../domains/social.ts`. The conformance suite validates both backends'
// answers against them. Zod v3.
// ============================================================================

const timestamp = z.string();
const platform = z.enum(['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok']);

/** `{ id }`: what the create and update routes answer. */
export const socialIdRefSchema = z.object({ id: z.string() });

export const socialPlatformContentSchema = z.object({
  platform,
  accountId: z.string(),
  content: z.string().optional(),
  platformPostId: z.string().optional(),
  publishedUrl: z.string().optional(),
  status: z.enum(['pending', 'published', 'failed']).optional(),
  error: z.string().optional(),
  publishedAt: z.string().optional(),
});

/** A social account, its OAuth tokens left out. */
export const socialAccountSchema = z.object({
  id: z.string(),
  platform,
  platformAccountId: z.string(),
  name: z.string(),
  username: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive', 'expired', 'error', 'pending_reauth']),
  postpeerIntegrationId: z.string().nullable().optional(),
  postpeerProfileId: z.string().nullable().optional(),
  followerCount: z.number().nullable().optional(),
  isDefault: z.boolean().nullable().optional(),
  lastSyncAt: timestamp.nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const socialPostSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  content: z.string(),
  postType: z.enum(['post', 'story', 'reel', 'thread', 'carousel', 'poll']),
  status: z.enum(['draft', 'pending_approval', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'cancelled']),
  targetAccountIds: z.array(z.string()),
  platformContent: z.array(socialPlatformContentSchema).nullable().optional(),
  mediaIds: z.array(z.string()).nullable().optional(),
  scheduledAt: timestamp.nullable().optional(),
  publishedAt: timestamp.nullable().optional(),
  timezone: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
  postpeerPostId: z.string().nullable().optional(),
  labels: z.array(z.string()).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  createdByUserId: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const socialCampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']),
  startDate: timestamp.nullable().optional(),
  endDate: timestamp.nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const socialMediaSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mediaType: z.enum(['image', 'video', 'gif']),
  url: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  status: z.string(),
  altText: z.string().nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const socialApprovalSchema = z.object({
  id: z.string(),
  postId: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'revision_requested', 'withdrawn', 'expired']),
  submittedByUserId: z.string().nullable().optional(),
  decisionNotes: z.string().nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const socialTeamMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  role: z.enum(['owner', 'admin', 'manager', 'editor', 'contributor', 'viewer']),
  isActive: z.boolean().nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/** `POST /api/social-accounts/connect`. */
export const socialConnectResultSchema = z.object({
  url: z.string(),
  profileId: z.string(),
  appId: z.string().optional(),
});

/** `POST /api/social-accounts/sync`. */
export const socialSyncResultSchema = z.object({
  synced: z.number(),
  accountIds: z.array(z.string()),
});

/** `POST /api/social-posts/:id/publish|schedule|reschedule`. */
export const socialPublishResultSchema = z.object({
  postId: z.string(),
  postpeerPostId: z.string(),
  status: z.enum(['published', 'scheduled', 'failed']),
  platformContent: z.array(socialPlatformContentSchema),
});

/** `POST /api/social-posts/:id/cancel`. */
export const socialCancelResultSchema = z.object({ id: z.string(), status: z.string() });

/** `POST /api/social-approvals`. */
export const socialApprovalCreatedSchema = z.object({ id: z.string(), postId: z.string() });

/** `POST /api/social-approvals/:id/approve`. */
export const socialApprovalApprovedSchema = z.object({
  approvalId: z.string(),
  postId: z.string(),
  status: z.literal('approved'),
  scheduled: z.boolean(),
  scheduleError: z.string().nullable(),
  publishResult: socialPublishResultSchema.nullable(),
});

/** `POST /api/social-approvals/:id/reject`. */
export const socialApprovalDecidedSchema = z.object({
  approvalId: z.string(),
  postId: z.string(),
  status: z.enum(['rejected', 'revision_requested']),
});

/** `GET /api/social-analytics/overview`. */
export const socialAnalyticsOverviewSchema = z.object({
  totalImpressions: z.number(),
  totalReach: z.number(),
  totalEngagement: z.number(),
  totalClicks: z.number(),
  engagementRate: z.number(),
  topPosts: z.array(z.unknown()),
  platformStats: z.array(
    z.object({ platform: z.string(), followers: z.number(), posts: z.number(), engagement: z.number() }),
  ),
});

/** `GET /api/social-analytics/stats`. */
export const socialDashboardStatsSchema = z.object({
  totalPosts: z.number(),
  scheduledPosts: z.number(),
  publishedThisWeek: z.number(),
  pendingApproval: z.number(),
  totalEngagement: z.number(),
  connectedAccounts: z.number(),
});

/** One hit of `GET /api/social-analytics/search`. */
export const socialSearchResultSchema = z.object({
  type: z.enum(['post', 'account', 'campaign']),
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  url: z.string(),
});

/** `POST /api/social-analytics/:postId/sync`. */
export const socialAnalyticsSyncSchema = z.object({ snapshots: z.number() });

/** `GET /api/social-settings`. */
export const socialSettingsSchema = z
  .object({
    defaultTimezone: z.string(),
    defaultApprovalRequired: z.boolean(),
    autoScheduleEnabled: z.boolean(),
    hashtagSuggestions: z.boolean(),
    linkShortening: z.boolean(),
  })
  .passthrough();

/** One of `GET /api/social-settings/timezones`. */
export const socialTimezoneSchema = z.string();

/** `PUT /api/social-settings`. */
export const socialSettingsSavedSchema = z.object({ message: z.string() });

/** `POST /public/social/postpeer/webhook`: no envelope. */
export const postpeerWebhookAckSchema = z.object({
  ok: z.literal(true),
  ignored: z.enum(['no_post_id', 'unknown_post']).optional(),
  reconciled: z.boolean().optional(),
});
