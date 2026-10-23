/**
 * Events the platform placed from a task.
 *
 * The scheduler writes every one as `type: 'reminder'`, `status: 'confirmed'`
 * (cancelled once the task is done), so "Reminder · Confirmed" says nothing
 * about the task behind it. These helpers let the UI show it as a task.
 */

import type { CalendarEvent, EventStatus } from '@/types/weldcalendar';

export function isTaskEvent(event: Pick<CalendarEvent, 'sourceType'>): boolean {
  return event.sourceType === 'task';
}

/**
 * The status pill to show, or null for none. A task block is "confirmed" by
 * construction, so only a different state (cancelled = the task is closed) is
 * worth a pill.
 */
export function visibleEventStatus(
  event: Pick<CalendarEvent, 'sourceType' | 'status'>,
): EventStatus | null {
  if (isTaskEvent(event) && event.status === 'confirmed') return null;
  return event.status;
}
