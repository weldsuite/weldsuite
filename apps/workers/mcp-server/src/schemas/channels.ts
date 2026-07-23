// AUTO-COPIED from @weldsuite/core-api-client/schemas/channels
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createChannelSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.string().max(30).optional(),
  isPrivate: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateChannelSchema = createChannelSchema.partial();
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;
