/**
 * Google Calendar integration (Google Workspace). Reuses the shared Google OAuth client.
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
        { key: 'calendarId', label: 'Calendar ID', type: 'string', required: false, placeholder: 'primary' },
        { key: 'summary', label: 'Title', type: 'string', required: true },
        { key: 'startDateTime', label: 'Start (ISO 8601)', type: 'string', required: true, placeholder: '2026-07-01T09:00:00Z' },
        { key: 'endDateTime', label: 'End (ISO 8601)', type: 'string', required: true },
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
