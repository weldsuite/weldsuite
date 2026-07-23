import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { helpdeskConversations } from './helpdesk-conversations';
import type { MessageBlock, BlockResponse } from './welddesk-blocks';

// Message types
export type MessageAuthorType = 'customer' | 'agent' | 'system';
export type MessageType = 'message' | 'note' | 'system';
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface MessageAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export const helpdeskConversationMessages = pgTable('helpdesk_conversation_messages', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Conversation reference
  conversationId: varchar('conversation_id', { length: 30 }).notNull().references(() => helpdeskConversations.id),

  // Author
  authorId: varchar('author_id', { length: 255 }),
  authorName: varchar('author_name', { length: 255 }).notNull(),
  authorEmail: varchar('author_email', { length: 255 }),
  authorType: varchar('author_type', { length: 20 }).notNull().default('customer'),
  authorAvatar: varchar('author_avatar', { length: 500 }),

  // Content
  content: text('content').notNull(),
  htmlContent: text('html_content'),
  plainContent: text('plain_content'),

  // Type & Visibility
  type: varchar('type', { length: 20 }).notNull().default('message'),
  isPublic: boolean('is_public').notNull().default(true),
  isInternal: boolean('is_internal').default(false),

  // Status
  status: varchar('status', { length: 20 }).default('sent'),
  isRead: boolean('is_read').notNull().default(false),
  readAt: timestamp('read_at'),

  // Attachments
  attachments: jsonb('attachments').$type<MessageAttachment[]>(),
  hasAttachments: boolean('has_attachments').default(false),

  // Interactive message blocks (Block Kit-style component system)
  blocks: jsonb('blocks').$type<MessageBlock[]>(),
  blockResponses: jsonb('block_responses').$type<Record<string, BlockResponse>>(),

  // Email threading (for email-channel messages)
  emailMessageId: varchar('email_message_id', { length: 255 }),
  inReplyTo: varchar('in_reply_to', { length: 255 }),
  cc: jsonb('cc').$type<string[]>(),
  bcc: jsonb('bcc').$type<string[]>(),
  subject: varchar('subject', { length: 500 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('helpdesk_conv_messages_conversation_idx').on(table.conversationId),
  index('helpdesk_conv_messages_author_idx').on(table.authorId),
  index('helpdesk_conv_messages_author_type_idx').on(table.authorType),
  index('helpdesk_conv_messages_type_idx').on(table.type),
  index('helpdesk_conv_messages_is_public_idx').on(table.isPublic),
  index('helpdesk_conv_messages_created_at_idx').on(table.createdAt),
  index('helpdesk_conv_messages_conv_created_idx').on(table.conversationId, table.createdAt),
]);

export type HelpdeskConversationMessage = typeof helpdeskConversationMessages.$inferSelect;
export type NewHelpdeskConversationMessage = typeof helpdeskConversationMessages.$inferInsert;
