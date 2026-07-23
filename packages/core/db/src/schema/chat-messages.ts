import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { chatChannels } from './chat-channels';

// Message types
export type ChatMessageType = 'message' | 'system' | 'file';
export type ChatAuthorType = 'user' | 'agent' | 'system';

export interface ChatAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  thumbnailUrl?: string;
}

export interface ChatClipTranscript {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  fullText?: string;
  segments?: Array<{
    text: string;
    startTime: number;
    endTime: number;
    timestamp: string;
  }>;
  errorMessage?: string;
}

export interface ChatClipAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  thumbnailUrl?: string;
  clipType: 'audio' | 'video' | 'screen';
  durationSeconds: number;
  transcript?: ChatClipTranscript;
}

/**
 * Snapshot of the original message embedded on a forwarded copy.
 * Snapshotted so the forwarded view stays intact if the original is edited or deleted.
 * When forwarding an already-forwarded message, this points to the original source, not the intermediate hop.
 */
export interface ChatForwardedFrom {
  messageId: string;
  channelId: string;
  channelName: string;
  channelType: 'public' | 'private' | 'dm';
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  htmlContent?: string;
  createdAt: string;
  attachments?: (ChatAttachment | ChatClipAttachment)[];
}

export const chatMessages = pgTable('chat_messages', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Channel reference
  channelId: varchar('channel_id', { length: 30 }).notNull().references(() => chatChannels.id),

  // Author
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }).notNull(),
  authorAvatar: varchar('author_avatar', { length: 500 }),
  // 'agent' for messages posted by AI agents; 'system' for system events; 'user' (default) for humans
  authorType: varchar('author_type', { length: 20 }).notNull().default('user'),

  // Content
  content: text('content').notNull(),
  htmlContent: text('html_content'),
  type: varchar('type', { length: 20 }).notNull().default('message'),

  // Threading
  parentId: varchar('parent_id', { length: 30 }),
  threadReplyCount: integer('thread_reply_count').notNull().default(0),
  threadLastReplyAt: timestamp('thread_last_reply_at'),
  threadParticipantIds: jsonb('thread_participant_ids').$type<string[]>(),

  // Edit tracking
  isEdited: boolean('is_edited').notNull().default(false),
  editedAt: timestamp('edited_at'),

  // Pinning
  isPinned: boolean('is_pinned').notNull().default(false),
  pinnedAt: timestamp('pinned_at'),
  pinnedBy: varchar('pinned_by', { length: 255 }),
  pinExpiresAt: timestamp('pin_expires_at'),

  // Attachments
  attachments: jsonb('attachments').$type<(ChatAttachment | ChatClipAttachment)[]>(),
  hasAttachments: boolean('has_attachments').notNull().default(false),

  // Reactions (emoji -> userIds)
  reactions: jsonb('reactions').$type<Record<string, string[]>>(),

  // Mentions
  mentions: jsonb('mentions').$type<string[]>(),
  mentionsEveryone: boolean('mentions_everyone').notNull().default(false),

  // Forwarded from (snapshot of original message; null for non-forwarded messages)
  forwardedFrom: jsonb('forwarded_from').$type<ChatForwardedFrom>(),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('chat_messages_channel_created_idx').on(table.channelId, table.createdAt),
  index('chat_messages_channel_idx').on(table.channelId),
  index('chat_messages_author_idx').on(table.authorId),
  index('chat_messages_parent_idx').on(table.parentId),
  index('chat_messages_is_pinned_idx').on(table.isPinned),
]);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
