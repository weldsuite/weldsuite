import { z } from 'zod';

// ============================================================================
// WeldChat entity channels — lets any business entity (task, ticket, deal, …)
// have its own chat channel. The channel is created lazily on the first
// message via POST /:entityType/:entityId/messages.
//
// Backed by `chat_channels` (type = 'entity') + `chat_channel_members`.
// Permission prefix: `channels:*` (read) / `messages:*` (post).
// ============================================================================

export const sendEntityMessageSchema = z.object({
  content: z.string().min(1),
  htmlContent: z.string().optional(),
  parentId: z.string().nullish(),
  mentions: z.array(z.string()).optional(),
  mentionsEveryone: z.boolean().optional(),
  attachments: z.array(z.record(z.any())).optional(),
  metadata: z.record(z.any()).optional(),
});

export type SendEntityMessageInput = z.infer<typeof sendEntityMessageSchema>;
