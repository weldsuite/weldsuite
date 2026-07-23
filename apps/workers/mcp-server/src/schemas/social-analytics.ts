// AUTO-COPIED from @weldsuite/core-api-client/schemas/social-analytics
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/core-api-client. Keep in sync with source.

import { z } from 'zod';

export const createSocialAnalyticsSchema = z.object({
  postId: z.string(),
  accountId: z.string(),
  platformPostId: z.string().max(255).optional(),
  snapshotPeriod: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'lifetime']).optional(),
  impressions: z.number().int().optional(),
  reach: z.number().int().optional(),
  likes: z.number().int().optional(),
  comments: z.number().int().optional(),
  shares: z.number().int().optional(),
  saves: z.number().int().optional(),
  clicks: z.number().int().optional(),
  totalEngagement: z.number().int().optional(),
  engagementRate: z.union([z.string(), z.number()]).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateSocialAnalyticsSchema = createSocialAnalyticsSchema.partial();
export type CreateSocialAnalyticsInput = z.infer<typeof createSocialAnalyticsSchema>;
export type UpdateSocialAnalyticsInput = z.infer<typeof updateSocialAnalyticsSchema>;
