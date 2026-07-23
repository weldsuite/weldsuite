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

export interface NoteAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export const helpdeskTicketNotes = pgTable('helpdesk_ticket_notes', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Ticket reference
  ticketId: varchar('ticket_id', { length: 30 }).notNull().references(() => helpdeskTickets.id),

  // Author
  authorId: varchar('author_id', { length: 255 }).notNull(),
  authorName: varchar('author_name', { length: 255 }).notNull(),

  // Content
  content: text('content').notNull(),

  // Flags
  isImportant: boolean('is_important').default(false),

  // Attachments
  attachments: jsonb('attachments').$type<NoteAttachment[]>(),
}, (table) => [
  index('helpdesk_ticket_notes_ticket_idx').on(table.ticketId),
  index('helpdesk_ticket_notes_author_idx').on(table.authorId),
  index('helpdesk_ticket_notes_created_at_idx').on(table.createdAt),
]);

export type HelpdeskTicketNote = typeof helpdeskTicketNotes.$inferSelect;
export type NewHelpdeskTicketNote = typeof helpdeskTicketNotes.$inferInsert;
