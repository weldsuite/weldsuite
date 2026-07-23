// AUTO-COPIED from @weldsuite/core-api-client/schemas/social-accounts
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/core-api-client. Keep in sync with source.

import { z } from 'zod';

export const createSocialAccountSchema = z.object({
  platform: z.string().max(50),
  username: z.string().max(255).optional(),
  displayName: z.string().max(255).optional(),
  status: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateSocialAccountSchema = createSocialAccountSchema.partial();
export type CreateSocialAccountInput = z.infer<typeof createSocialAccountSchema>;
export type UpdateSocialAccountInput = z.infer<typeof updateSocialAccountSchema>;
