/**
 * Who may write where.
 *
 * The list route annotates every calendar with `isOwn` + `permission`, derived
 * from `calendarShares` rather than stored as columns. The create/update
 * routes check the same thing server-side, so these helpers exist to keep the
 * UI from offering an action that would come back a 403.
 */

import type { Calendar, CalendarEvent } from '@/types/weldcalendar';

export function calendarPickerLabel(calendar: Calendar, personalLabel: string): string {
  if (calendar.tenantKind === 'personal') {
    return `${personalLabel} · ${calendar.name}`;
  }
  if (calendar.workspaceName) {
    return `${calendar.workspaceName} · ${calendar.name}`;
  }
  return calendar.name;
}

/** `view` is read-only; `edit` and `manage` both allow writing events. */
export function canWriteToCalendar(calendar: Calendar): boolean {
  return calendar.isOwn || calendar.permission === 'edit' || calendar.permission === 'manage';
}

/** The calendars an event may be created in or moved within. */
export function writableCalendars(calendars: Calendar[]): Calendar[] {
  return calendars.filter(canWriteToCalendar);
}

/**
 * Whether the signed-in user may edit a given event.
 *
 * Access follows the CALENDAR, not the organiser: the routes reach events
 * through the calendars you can see, so a colleague's event on a calendar
 * shared with you at `edit` is yours to change. An event whose calendar is not
 * in the list at all (still loading, or just unshared) is treated as
 * read-only — the safer default.
 */
export function canEditEvent(
  event: Pick<CalendarEvent, 'calendarId'>,
  calendars: Calendar[],
): boolean {
  const calendar = calendars.find((c) => c.id === event.calendarId);
  return calendar ? canWriteToCalendar(calendar) : false;
}
