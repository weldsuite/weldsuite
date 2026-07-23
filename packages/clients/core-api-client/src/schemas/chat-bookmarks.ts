import { z } from 'zod';

export const createChatBookmarkSchema = z.object({
  messageId: z.string().nullish(),
  channelId: z.string().nullish(),
  userId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateChatBookmarkSchema = createChatBookmarkSchema.partial();
export type CreateChatBookmarkInput = z.infer<typeof createChatBookmarkSchema>;
export type UpdateChatBookmarkInput = z.infer<typeof updateChatBookmarkSchema>;
