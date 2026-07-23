// AUTO-COPIED from @weldsuite/core-api-client/schemas/social-posts
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/core-api-client. Keep in sync with source.

import { z } from 'zod';

export const createSocialPostSchema = z.object({
  title: z.string().max(255).optional(),
  content: z.string().optional(),
  postType: z.enum(['post', 'story', 'reel', 'thread', 'carousel', 'poll']).optional(),
  status: z.string().max(30).optional(),
  targetAccountIds: z.array(z.string()).optional(),
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
