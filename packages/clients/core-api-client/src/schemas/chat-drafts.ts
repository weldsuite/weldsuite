import { z } from 'zod';

export const createChatDraftSchema = z.object({
  channelId: z.string().nullish(),
  body: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateChatDraftSchema = createChatDraftSchema.partial();
export type CreateChatDraftInput = z.infer<typeof createChatDraftSchema>;
export type UpdateChatDraftInput = z.infer<typeof updateChatDraftSchema>;
