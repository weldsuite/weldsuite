import { z } from 'zod';

// `/api/ticket-types` — backed by `helpdesk_ticket_types`. Workspace-defined
// classification for tickets (e.g. "Incident", "Service Request", "Question").

export const createTicketTypeSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateTicketTypeSchema = createTicketTypeSchema.partial();

export type CreateTicketTypeInput = z.infer<typeof createTicketTypeSchema>;
export type UpdateTicketTypeInput = z.infer<typeof updateTicketTypeSchema>;
