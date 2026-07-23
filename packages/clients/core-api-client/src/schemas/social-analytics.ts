import { z } from 'zod';

/**
 * Social analytics snapshot schema (used by external-api + MCP). Analytics are
 * append-only metric snapshots; creation is normally driven by the publishing
 * service syncing from PostPeer, but the external surface allows manual writes.
 */
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
