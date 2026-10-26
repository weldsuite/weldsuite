import { z } from 'zod';

// ============================================================================
// WeldChat entity channels ("record chats") — lets any business record
// (company, person, task, project, domain) have its own chat channel. The
// channel is created lazily on the first message via
// POST /:entityType/:entityId/messages (or on the first follow).
//
// Backed by `chat_channels` (type = 'entity') + `chat_channel_members`. A
// membership row means the user FOLLOWS the chat (sidebar, unread state,
// notifications).
// Permission prefix: `channels:*` (read) / `messages:*` (post), plus the
// record type's own read permission (e.g. `companies:read`).
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

/** Record chat types, in sidebar group order. */
export const RECORD_CHAT_TYPES = ['company', 'person', 'task', 'project', 'domain'] as const;
export type RecordChatType = (typeof RECORD_CHAT_TYPES)[number];

/**
 * `following`: chats the caller follows. `unread`: followed, not muted, with
 * messages after the caller's read marker. `mentions`: followed, with unread
 * @mentions. `all`: every record chat the caller may read.
 */
export const RECORD_CHAT_FILTERS = ['following', 'unread', 'mentions', 'all'] as const;
export type RecordChatFilter = (typeof RECORD_CHAT_FILTERS)[number];

/** GET /api/chat-entity-channels */
export const listEntityChannelsQuerySchema = z.object({
  type: z.string().min(1).max(50).optional(),
  filter: z.enum(RECORD_CHAT_FILTERS).default('following'),
  search: z.string().trim().max(200).optional(),
  /** The id of the last chat on the previous page. */
  cursor: z.string().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListEntityChannelsQuery = z.input<typeof listEntityChannelsQuerySchema>;

/** PATCH /api/chat-entity-channels/:entityType/mute */
export const muteRecordChatsSchema = z.object({
  isMuted: z.boolean(),
});

export type MuteRecordChatsInput = z.infer<typeof muteRecordChatsSchema>;

/** The caller's own state on one record chat (absent membership = not following). */
export interface RecordChatCallerState {
  isFollowing: boolean;
  isMuted: boolean;
  lastReadAt: string | null;
  lastReadMessageId: string | null;
  unreadMentionCount: number;
}

/** One row of GET /api/chat-entity-channels/summary. */
export interface RecordChatTypeSummary {
  type: string;
  label: string;
  /** Chats of this type the caller follows. */
  followed: number;
  /** Followed, not muted chats with messages after the caller's read marker. */
  unread: number;
  /** Unread @mentions across the followed chats (muted ones included). */
  mentions: number;
}
