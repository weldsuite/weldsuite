import { z } from 'zod';

/**
 * Social post create/update schema. `.passthrough()` keeps it permissive so
 * the rich JSONB fields (hashtagSettings, linkSettings, pollConfig, …) flow
 * through to the server, while the named fields below are validated.
 */
export const createSocialPostSchema = z.object({
  title: z.string().max(255).optional(),
  content: z.string().optional(),
  postType: z.enum(['post', 'story', 'reel', 'thread', 'carousel', 'poll']).optional(),
  status: z.string().max(30).optional(),
  /** Account ids this post targets (socialAccounts.id). */
  targetAccountIds: z.array(z.string()).optional(),
  /** Legacy alias accepted for compatibility. */
  accountIds: z.array(z.string()).optional(),
  mediaIds: z.array(z.string()).optional(),
  scheduledAt: z.string().optional(),
  publishedAt: z.string().optional(),
  timezone: z.string().max(50).optional(),
  campaignId: z.string().nullish(),
  labels: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  internalNotes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateSocialPostSchema = createSocialPostSchema.partial();
export type CreateSocialPostInput = z.infer<typeof createSocialPostSchema>;
export type UpdateSocialPostInput = z.infer<typeof updateSocialPostSchema>;
