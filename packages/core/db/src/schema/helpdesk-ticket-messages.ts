import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { helpdeskTickets } from './helpdesk-tickets';

// Message types
export type MessageType = 'reply' | 'note' | 'forward' | 'system';
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface MessageAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export const helpdeskTicketMessages = pgTable('helpdesk_ticket_messages', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Ticket reference
  ticketId: varchar('ticket_id', { length: 30 }).notNull().references(() => helpdeskTickets.id),

  // Author
  authorId: varchar('author_id', { length: 255 }),
  authorName: varchar('author_name', { length: 255 }).notNull(),
  authorEmail: varchar('author_email', { length: 255 }).notNull(),
  authorType: varchar('author_type', { length: 20 }).notNull().default('customer'),

  // Content
  subject: varchar('subject', { length: 500 }),
  body: text('body').notNull(),
  htmlBody: text('html_body'),
  plainBody: text('plain_body'),

  // Type
  type: varchar('type', { length: 20 }).notNull().default('reply'),
  isPublic: boolean('is_public').notNull().default(true),
  isInternal: boolean('is_internal').default(false),

  // Status
  status: varchar('status', { length: 20 }).default('sent'),
  readAt: timestamp('read_at'),

  // Email Details
  messageId: varchar('message_id', { length: 255 }),
  inReplyTo: varchar('in_reply_to', { length: 255 }),
  cc: jsonb('cc').$type<string[]>(),
  bcc: jsonb('bcc').$type<string[]>(),

  // Attachments
  attachments: jsonb('attachments').$type<MessageAttachment[]>(),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('helpdesk_ticket_messages_ticket_idx').on(table.ticketId),
  index('helpdesk_ticket_messages_author_idx').on(table.authorId),
  index('helpdesk_ticket_messages_author_type_idx').on(table.authorType),
  index('helpdesk_ticket_messages_type_idx').on(table.type),
  index('helpdesk_ticket_messages_is_public_idx').on(table.isPublic),
  index('helpdesk_ticket_messages_created_at_idx').on(table.createdAt),
]);

export type HelpdeskTicketMessage = typeof helpdeskTicketMessages.$inferSelect;
export type NewHelpdeskTicketMessage = typeof helpdeskTicketMessages.$inferInsert;
