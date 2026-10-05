/**
 * Every system email, by id. Adding a template: create the file under
 * `templates/<area>/`, register it here, add its strings to
 * `@weldsuite/i18n/locales/{en,nl}/emails.ts` and a preview entry under
 * `emails/`. The snapshot test picks it up from this registry.
 */

import bookingConfirmed from './booking/confirmed';
import calendarEvent from './calendar/event';
import notification from './notifications/notification';

export const templates = {
  'calendar.event': calendarEvent,
  'booking.confirmed': bookingConfirmed,
  notification,
};

export type TemplateId = keyof typeof templates;

/** The props a template takes. */
export type TemplateProps<Id extends TemplateId> =
  (typeof templates)[Id] extends { previews: Record<string, { props: infer P }> } ? P : never;

export type { CalendarEventEmailProps, CalendarEventKind } from './calendar/event';
export type { BookingConfirmedEmailProps, BookingLocation } from './booking/confirmed';
export type { NotificationEmailProps } from './notifications/notification';
