import { z } from 'zod';

// `/api/ticket-notes` — backed by `helpdesk_ticket_notes`. Internal-only notes
// attached to a ticket. Visible to agents, not customers.

export const createTicketNoteSchema = z.object({
  ticketId: z.string(),
  authorId: z.string().nullish(),
  authorName: z.string().max(255).optional(),
  body: z.string(),
  isPinned: z.boolean().optional(),
  mentions: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateTicketNoteSchema = createTicketNoteSchema.partial();

export type CreateTicketNoteInput = z.infer<typeof createTicketNoteSchema>;
export type UpdateTicketNoteInput = z.infer<typeof updateTicketNoteSchema>;

/** A `helpdesk_ticket_notes` row, as /api/ticket-notes returns it. */
export const ticketNoteSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    ticketId: z.string(),
    authorId: z.string(),
    authorName: z.string(),
    content: z.string(),
    isImportant: z.boolean().nullable(),
    attachments: z.unknown(),
  })
  .passthrough();
