import { z } from 'zod';

// `/api/ticket-messages` — backed by `helpdesk_ticket_messages`.
// Pass-through schemas; tighten as the frontend cuts over.

export const createTicketMessageSchema = z.object({
  ticketId: z.string(),
  subject: z.string().max(500).optional(),
  body: z.string().optional(),
  bodyHtml: z.string().optional(),
  authorType: z.enum(['agent', 'customer', 'system', 'bot']).optional(),
  authorId: z.string().nullish(),
  authorName: z.string().max(255).optional(),
  authorEmail: z.string().email().max(255).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  channel: z.string().max(30).optional(),
  isPublic: z.boolean().optional(),
  isInternal: z.boolean().optional(),
  attachments: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateTicketMessageSchema = createTicketMessageSchema.partial();

export type CreateTicketMessageInput = z.infer<typeof createTicketMessageSchema>;
export type UpdateTicketMessageInput = z.infer<typeof updateTicketMessageSchema>;

/** A `helpdesk_ticket_messages` row, as /api/ticket-messages returns it. */
export const ticketMessageSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    ticketId: z.string(),
    authorId: z.string().nullable(),
    authorName: z.string(),
    authorEmail: z.string(),
    authorType: z.string(),
    subject: z.string().nullable(),
    body: z.string(),
    htmlBody: z.string().nullable(),
    plainBody: z.string().nullable(),
    type: z.string(),
    isPublic: z.boolean(),
    isInternal: z.boolean().nullable(),
    status: z.string().nullable(),
    readAt: z.string().nullable(),
    messageId: z.string().nullable(),
    inReplyTo: z.string().nullable(),
    cc: z.unknown(),
    bcc: z.unknown(),
    attachments: z.unknown(),
    metadata: z.unknown(),
  })
  .passthrough();
