// AUTO-COPIED from @weldsuite/core-api-client/schemas/conversations
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

// `/api/conversations` — backed by `helpdesk_conversations`. A conversation
// is the top-level thread for an inbox/widget chat session; tickets attach
// to conversations.

export const createConversationSchema = z.object({
  subject: z.string().min(1).max(500),
  customerId: z.string().nullish(),
  customerName: z.string().max(255).optional(),
  customerEmail: z.string().email().max(255).optional(),
  channel: z.string().max(30).optional(),
  status: z.string().max(30).optional(),
  assigneeId: z.string().nullish(),
  departmentId: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateConversationSchema = createConversationSchema.partial();

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
