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
