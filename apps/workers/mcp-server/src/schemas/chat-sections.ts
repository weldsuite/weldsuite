// AUTO-COPIED from @weldsuite/core-api-client/schemas/chat-sections
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createChatSectionSchema = z.object({
  name: z.string().min(1).max(255),
  userId: z.string().nullish(),
  position: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateChatSectionSchema = createChatSectionSchema.partial();
export type CreateChatSectionInput = z.infer<typeof createChatSectionSchema>;
export type UpdateChatSectionInput = z.infer<typeof updateChatSectionSchema>;
