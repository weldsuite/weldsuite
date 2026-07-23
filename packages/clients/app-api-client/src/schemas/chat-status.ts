import { z } from 'zod';

// ============================================================================
// WeldChat user status — presence + custom status for the current user.
//
// Backed by the `chat_user_status` table
// (packages/db/src/schema/chat-user-status). Rows are per-user; the route
// upserts the caller's own status row.
//
// Permission prefix: `settings:*` (presence lives under workspace settings).
// ============================================================================

export const setChatStatusSchema = z.object({
  status: z.enum(['online', 'busy', 'away', 'dnd', 'offline']),
  statusText: z.string().max(255).optional(),
  statusEmoji: z.string().max(50).optional(),
  expiresAt: z.string().datetime().optional(),
});

export type SetChatStatusInput = z.infer<typeof setChatStatusSchema>;
