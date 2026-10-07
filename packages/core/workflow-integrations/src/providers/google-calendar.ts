/**
 * Google Calendar integration (Google Workspace). Reuses the shared Google
 * OAuth client (see "Provider pattern" in docs/plans/weldconnect.md). Not to
 * be confused with the unrelated, pre-existing `google_calendar` two-way sync
 * integration owned by calendar-api (GOOGLE_CALENDAR_CLIENT_ID/SECRET,
 * services/integrations/connections.ts) — this one is WeldConnect's own
 * connection, under the shared GOOGLE_CLIENT_ID/SECRET OAuth app.
 */

import type { IntegrationDef } from '../types';
import { googleAuth, GOOGLE_SCOPES } from './google';

export const googleCalendar: IntegrationDef = {
  id: 'google_calendar',
  type: 'google_calendar',
  label: 'Google Calendar',
  description: 'Create calendar events and trigger workflows when new events are added.',
  category: 'productivity',
  icon: 'calendar',
  auth: googleAuth(GOOGLE_SCOPES.calendar),
  actions: [
    {
      id: 'google_calendar.create_event',
      name: 'Create Event',
      description: 'Create an event on a calendar.',
      inputs: [
        { key: 'integrationId', label: 'Connection', type: 'string', description: 'Which connected Google account to use, when more than one is connected.' },
        { key: 'calendarId', label: 'Calendar', type: 'string', required: false, placeholder: 'primary' },
        { key: 'summary', label: 'Title', type: 'string', required: true },
        { key: 'startDateTime', label: 'Start (ISO 8601)', type: 'string', required: true, placeholder: '2026-07-01T09:00:00' },
        { key: 'endDateTime', label: 'End (ISO 8601)', type: 'string', required: true },
        { key: 'timeZone', label: 'Time zone', type: 'string', required: false, placeholder: 'Europe/Amsterdam', description: 'IANA time zone for start/end when they are not UTC (no trailing Z). Defaults to the calendar’s own time zone.' },
        { key: 'description', label: 'Description', type: 'text', required: false },
        { key: 'attendees', label: 'Attendees (comma emails)', type: 'string', required: false },
      ],
    },
  ],
  triggers: [
    {
      id: 'google_calendar.new_event',
      name: 'New Event',
      description: 'Triggers when a new upcoming event is created on the calendar.',
      kind: 'poll',
      outputFields: ['id', 'summary', 'start', 'end', 'htmlLink'],
    },
  ],
};
