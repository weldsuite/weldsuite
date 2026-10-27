import { z } from 'zod';

// ============================================================================
// WeldChat user status — the status the current user CHOSE, plus a custom
// text and emoji. Whether they are connected (online / away / in a call) is
// live presence, kept by the realtime WorkspaceHub and never set here
// (`@weldsuite/realtime/presence`).
//
// `status`: `online` = automatic (follow live presence), `busy`, `dnd`,
// `away` (stays away until changed), `offline` = appear offline.
//
// Backed by the `chat_user_status` table
// (packages/db/src/schema/chat-user-status). Rows are per-user; the route
// upserts the caller's own status row.
// ============================================================================

export const setChatStatusSchema = z.object({
  status: z.enum(['online', 'busy', 'away', 'dnd', 'offline']),
  statusText: z.string().max(255).optional(),
  statusEmoji: z.string().max(50).optional(),
  expiresAt: z.string().datetime().optional(),
});

export type SetChatStatusInput = z.infer<typeof setChatStatusSchema>;
