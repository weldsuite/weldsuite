// AUTO-COPIED from @weldsuite/app-api-client/schemas/tickets
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

// ============================================================================
// Helpdesk Tickets — `/api/tickets`.
//
// Backed by `helpdesk_tickets`. Schema is pass-through-ish to match the
// existing api-worker contract; tighten field types as the platform/mobile
// callers cut over to app-api.
// ============================================================================

export const ticketStatus = z.enum([
  'new',
  'open',
  'pending',
  'on_hold',
  'in_progress',
  'resolved',
  'closed',
  'cancelled',
]);

export const ticketPriority = z.enum(['low', 'medium', 'high', 'urgent', 'critical']);

export const createTicketSchema = z.object({
  ticketNumber: z.string().max(50).optional(),
  reference: z.string().max(100).optional(),

  contactId: z.string().nullish(),
  customerName: z.string().min(1).max(255),
  customerEmail: z.string().email().max(255),
  customerPhone: z.string().max(50).optional(),
  customerCompany: z.string().max(255).optional(),

  subject: z.string().min(1).max(500),
  description: z.string().optional(),
  category: z.string().max(50).optional(),
  subcategory: z.string().max(100).optional(),

  status: ticketStatus.optional(),
  priority: ticketPriority.optional(),
  severity: z.string().max(20).optional(),

  assigneeId: z.string().nullish(),
  assigneeName: z.string().max(255).optional(),
  departmentId: z.string().nullish(),
  teamId: z.string().nullish(),

  channel: z.string().max(20).optional(),
  sourceEmail: z.string().max(255).optional(),
  sourceUrl: z.string().max(500).optional(),

  type: z.string().max(30).optional(),
  ticketTypeId: z.string().nullish(),
  issueType: z.string().max(50).optional(),

  slaId: z.string().nullish(),

  productId: z.string().nullish(),
  productName: z.string().max(255).optional(),

  tags: z.array(z.string()).optional(),
  customFields: z.unknown().optional(),

  parentTicketId: z.string().nullish(),
  isPublic: z.boolean().optional(),
  metadata: z.unknown().optional(),
});

export const updateTicketSchema = createTicketSchema.partial();

export const listTicketsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  assigneeId: z.string().optional(),
  departmentId: z.string().optional(),
  channel: z.string().optional(),
  category: z.string().optional(),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type ListTicketsQuery = z.infer<typeof listTicketsQuery>;
