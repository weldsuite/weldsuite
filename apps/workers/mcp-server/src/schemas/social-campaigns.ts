// AUTO-COPIED from @weldsuite/core-api-client/schemas/social-campaigns
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/core-api-client. Keep in sync with source.

import { z } from 'zod';

export const createSocialCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  status: z.string().max(30).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  budget: z.union([z.string(), z.number()]).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateSocialCampaignSchema = createSocialCampaignSchema.partial();
export type CreateSocialCampaignInput = z.infer<typeof createSocialCampaignSchema>;
export type UpdateSocialCampaignInput = z.infer<typeof updateSocialCampaignSchema>;
