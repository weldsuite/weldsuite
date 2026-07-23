import { z } from 'zod';

/**
 * Zod schemas for calendar event operations shared between
 * api-worker (PATCH /calendar/events/:id/reschedule) and any
 * future core-api calendar routes.
 */

export const calendarRescheduleInputSchema = z.object({
  startTime: z.string().min(1),
  endTime: z.string().optional(),
  /**
   * When true the user explicitly chose this time slot (e.g. via drag-to-pin).
   * The server will set autoScheduled=false on the event and write the new
   * start back to the linked task (startDate) or CRM activity (startTime/endTime)
   * so the cron / cascading-bump logic will not move it again.
   *
   * Defaults to false for backwards-compat; programmatic reschedules from
   * the cron or cascading-bump path pass manual=false (or omit the field).
   */
  manual: z.boolean().optional().default(false),
});

export type CalendarRescheduleInput = z.infer<typeof calendarRescheduleInputSchema>;
