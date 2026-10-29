import { z } from 'zod';

// `/api/helpdesk-stats` — read-only ticket counts.

/** `GET /api/helpdesk-stats`: live (not deleted) tickets counted by status and priority. */
export const helpdeskStatsSchema = z.object({
  totalTickets: z.number().int(),
  openTickets: z.number().int(),
  pendingTickets: z.number().int(),
  resolvedTickets: z.number().int(),
  closedTickets: z.number().int(),
  newTickets: z.number().int(),
  urgentTickets: z.number().int(),
  highPriorityTickets: z.number().int(),
});
