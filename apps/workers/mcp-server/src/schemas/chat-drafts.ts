// AUTO-COPIED from @weldsuite/core-api-client/schemas/chat-drafts
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createChatDraftSchema = z.object({
  channelId: z.string().nullish(),
  body: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateChatDraftSchema = createChatDraftSchema.partial();
export type CreateChatDraftInput = z.infer<typeof createChatDraftSchema>;
export type UpdateChatDraftInput = z.infer<typeof updateChatDraftSchema>;
