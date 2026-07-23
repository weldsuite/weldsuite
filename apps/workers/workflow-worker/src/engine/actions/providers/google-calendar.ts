/**
 * Google Calendar outbound action (`google_calendar.create_event`).
 */

import type { ActionHandler } from '../../types';
import { getValidIntegrationToken } from './token';

export const handleCalendarCreateEvent: ActionHandler = async (inputs, ctx) => {
  const summary = String(inputs.summary || '');
  const start = String(inputs.startDateTime || '');
  const end = String(inputs.endDateTime || '');
  if (!summary) throw new Error('Event title (summary) is required');
  if (!start || !end) throw new Error('Event start and end are required');

  const { accessToken } = await getValidIntegrationToken(ctx, {
    type: 'google_calendar',
    integrationId: inputs.integrationId ? String(inputs.integrationId) : undefined,
  });

  const calendarId = inputs.calendarId ? String(inputs.calendarId) : 'primary';
  const attendees = inputs.attendees
    ? String(inputs.attendees)
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((email) => ({ email }))
    : undefined;

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description: inputs.description ? String(inputs.description) : undefined,
        start: { dateTime: start },
        end: { dateTime: end },
        attendees,
      }),
    },
  );
  if (!res.ok) throw new Error(`Calendar create failed: ${res.status} - ${await res.text()}`);
  const json = (await res.json()) as { id?: string; htmlLink?: string };
  return { created: true, id: json.id, htmlLink: json.htmlLink };
};
