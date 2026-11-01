import { z } from 'zod';

// ============================================================================
// WeldAds (ads-api): Meta ad connections, ad accounts and ad campaigns.
//
// The response shapes of /api/ad-connections, /api/ad-accounts and
// /api/ad-campaigns, matching the interfaces of the platform's
// `hooks/queries/use-weldads-queries.ts`. The conformance suite validates
// both backends' answers against them. Zod v3.
// ============================================================================

const timestamp = z.string();

/** A connected ad platform (`ad_platform_connections`), tokens left out. */
export const adPlatformConnectionSchema = z.object({
  id: z.string(),
  platform: z.enum(['facebook', 'google']),
  status: z.enum(['active', 'error', 'pending_reauth']),
  metaUserId: z.string().nullable().optional(),
  metaUserName: z.string().nullable().optional(),
  tokenExpiresAt: timestamp.nullable().optional(),
  lastSyncAt: timestamp.nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/** An ad account found on a connection (`ad_accounts`). */
export const adAccountSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  platformAccountId: z.string(),
  name: z.string(),
  currency: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  isSelected: z.boolean(),
});

/** Last-30-day insights Meta reported for a campaign. */
export const adCampaignMetricsSchema = z.object({
  spend: z.string().optional(),
  impressions: z.string().optional(),
  clicks: z.string().optional(),
  ctr: z.string().optional(),
  cpc: z.string().optional(),
  reach: z.string().optional(),
  dateStart: z.string().optional(),
  dateEnd: z.string().optional(),
});

/** An ad campaign (`ad_campaigns`): a single campaign, or a write's answer. */
export const adCampaignSchema = z.object({
  id: z.string(),
  adAccountId: z.string(),
  /** Null until the campaign is pushed to the ad platform. */
  platformCampaignId: z.string().nullable(),
  name: z.string(),
  status: z.string().nullable().optional(),
  objective: z.string().nullable().optional(),
  dailyBudget: z.number().nullable().optional(),
  lifetimeBudget: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  metrics: adCampaignMetricsSchema.nullable().optional(),
  metricsSyncedAt: timestamp.nullable().optional(),
  syncStatus: z.enum(['local', 'pending_push', 'synced', 'error']).nullable().optional(),
  syncError: z.string().nullable().optional(),
  lastSyncedAt: timestamp.nullable().optional(),
});

/** A row of the campaign list, with its account's name and platform id. */
export const adCampaignRowSchema = adCampaignSchema.extend({
  accountName: z.string().optional(),
  platformAccountId: z.string().optional(),
});

/** `POST /api/ad-connections/facebook/authorize`. */
export const adOAuthStartSchema = z.object({
  authorizeUrl: z.string(),
  state: z.string(),
});

/** `POST /api/ad-connections/facebook/callback`. */
export const adConnectionRefSchema = z.object({
  id: z.string(),
  platform: z.enum(['facebook', 'google']),
  status: z.enum(['active', 'error', 'pending_reauth']),
});

/** `POST /api/ad-connections/:id/sync`. */
export const adSyncResultSchema = z.object({
  syncedCampaigns: z.number(),
  writtenCampaigns: z.number(),
  pushed: z.number(),
  failed: z.number(),
  pulled: z.number(),
});

export type AdPlatformConnection = z.infer<typeof adPlatformConnectionSchema>;
export type AdAccount = z.infer<typeof adAccountSchema>;
export type AdCampaign = z.infer<typeof adCampaignSchema>;
export type AdCampaignRow = z.infer<typeof adCampaignRowSchema>;
export type AdSyncResult = z.infer<typeof adSyncResultSchema>;
