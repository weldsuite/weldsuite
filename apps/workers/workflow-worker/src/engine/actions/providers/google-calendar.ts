/**
 * Google Calendar outbound action (`google_calendar.create_event`) — see
 * "Provider pattern" in docs/plans/weldconnect.md.
 */

import type { ActionHandler } from '../../types';
import { NonRetryableStepError } from '../../errors';
import { isValidRecipient } from '../communication';
import { getValidIntegrationToken } from './token';
import { throwGoogleApiError } from './google-errors';

/** Comma/semicolon list of attendee emails -> validated `{ email }` entries. */
function parseAttendees(raw: unknown): Array<{ email: string }> | undefined {
  if (raw == null || raw === '') return undefined;
  const emails = String(raw)
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter(Boolean);
  if (emails.length === 0) return undefined;
  const invalid = emails.find((e) => !isValidRecipient(e));
  if (invalid !== undefined) throw new NonRetryableStepError(`Attendee address "${invalid}" is not valid`);
  return emails.map((email) => ({ email }));
}

export const handleCalendarCreateEvent: ActionHandler = async (inputs, ctx) => {
  const summary = String(inputs.summary || '').trim();
  const start = String(inputs.startDateTime || '').trim();
  const end = String(inputs.endDateTime || '').trim();
  if (!summary) throw new NonRetryableStepError('Event title (summary) is required');
  if (!start || !end) throw new NonRetryableStepError('Event start and end are required');

  // A bare (no "Z"/offset) dateTime needs an explicit timeZone — Google
  // otherwise rejects it with a 400 ("Invalid time zone definition").
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(start) && /(Z|[+-]\d{2}:?\d{2})$/.test(end);
  const timeZone = inputs.timeZone ? String(inputs.timeZone).trim() : undefined;
  if (!hasOffset && !timeZone) {
    throw new NonRetryableStepError(
      'timeZone is required when startDateTime/endDateTime have no UTC offset (no trailing Z)',
    );
  }

  const attendees = parseAttendees(inputs.attendees);

  const { accessToken } = await getValidIntegrationToken(ctx, {
    type: 'google_calendar',
    integrationId: inputs.integrationId ? String(inputs.integrationId) : undefined,
  });

  const calendarId = inputs.calendarId ? String(inputs.calendarId).trim() : 'primary';

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description: inputs.description ? String(inputs.description) : undefined,
        start: { dateTime: start, timeZone },
        end: { dateTime: end, timeZone },
        attendees,
      }),
    },
  );
  if (!res.ok) await throwGoogleApiError(res, 'Calendar create event');
  const json = (await res.json()) as { id?: string; htmlLink?: string };
  return { ok: true, id: json.id, htmlLink: json.htmlLink };
};
