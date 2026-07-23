// AUTO-COPIED from @weldsuite/core-api-client/schemas/calendar-events
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createCalendarEventSchema = z.object({
  calendarId: z.string(),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  isAllDay: z.boolean().optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateCalendarEventSchema = createCalendarEventSchema.partial();
export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>;
export type UpdateCalendarEventInput = z.infer<typeof updateCalendarEventSchema>;
