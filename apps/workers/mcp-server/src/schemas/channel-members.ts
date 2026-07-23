// AUTO-COPIED from @weldsuite/core-api-client/schemas/channel-members
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createChannelMemberSchema = z.object({
  channelId: z.string(),
  userId: z.string(),
  role: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateChannelMemberSchema = createChannelMemberSchema.partial();
export type CreateChannelMemberInput = z.infer<typeof createChannelMemberSchema>;
export type UpdateChannelMemberInput = z.infer<typeof updateChannelMemberSchema>;
