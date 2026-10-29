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

/** A `helpdesk_ticket_types` row, as /api/ticket-types returns it. */
export const helpdeskTicketTypeSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    category: z.string().nullable(),
    fields: z.unknown(),
    states: z.unknown(),
    disableAiAutofill: z.boolean().nullable(),
    defaultPriority: z.string().nullable(),
    defaultAssigneeId: z.string().nullable(),
    defaultDepartmentId: z.string().nullable(),
    sortOrder: z.number().nullable(),
    isActive: z.boolean(),
  })
  .passthrough();
