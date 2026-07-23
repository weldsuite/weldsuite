import { z } from 'zod';

export const createChatMessageSchema = z.object({
  channelId: z.string().nullish(),
  authorId: z.string().nullish(),
  body: z.string().optional(),
  parentId: z.string().nullish(),
  attachments: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateChatMessageSchema = createChatMessageSchema.partial();
export type CreateChatMessageInput = z.infer<typeof createChatMessageSchema>;
export type UpdateChatMessageInput = z.infer<typeof updateChatMessageSchema>;

/** Body for POST /api/chat-messages/:id/reactions — toggle an emoji reaction. */
export const chatReactionSchema = z.object({
  emoji: z.string().min(1).max(50),
});
export type ChatReactionInput = z.infer<typeof chatReactionSchema>;

/** Body for POST /api/chat-messages/:id/pin — pin a message (all fields optional). */
export const chatPinSchema = z
  .object({
    /** ISO timestamp at which the pin should auto-expire. */
    expiresAt: z.string().optional(),
    /** When true, suppress the pin notification (UI hint; not persisted). */
    silent: z.boolean().optional(),
  })
  .optional();
export type ChatPinInput = z.infer<typeof chatPinSchema>;
