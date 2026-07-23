import { z } from 'zod';

// ============================================================================
// Queries
// ============================================================================

export const listActivityQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  filter: z.enum(['all', 'mentions', 'replies', 'dms']).default('all'),
});

export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;

// ============================================================================
// Response Interfaces
// ============================================================================

export interface ActivityItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  channelId: string | null;
  channelName: string | null;
  messageId: string | null;
  actorId: string | null;
  actorName: string | null;
  actorAvatarUrl: string | null;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface UnreadActivityCount {
  count: number;
}
