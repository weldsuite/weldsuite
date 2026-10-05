import { describe, it, expect } from 'vitest';
import {
  buildEventFormSchema,
  getEventPriorityOptions,
  getEventStatusOptions,
  getEventTypeOptions,
  labelFor,
  getEventTypeLabels,
  type EventOptionLabels,
} from './event-form-schema';

const labels: EventOptionLabels = {
  filterTypeMeeting: 'Vergadering',
  filterTypeCall: 'Gesprek',
  filterTypeAppointment: 'Afspraak',
  filterTypeEvent: 'Evenement',
  filterTypeTask: 'Taak',
  filterTypeOther: 'Overig',
  filterPriorityLow: 'Laag',
  filterPriorityNormal: 'Normaal',
  filterPriorityHigh: 'Hoog',
  filterPriorityUrgent: 'Urgent',
  filterStatusConfirmed: 'Bevestigd',
  filterStatusTentative: 'Onder voorbehoud',
  filterStatusCancelled: 'Geannuleerd',
};

describe('event option labels', () => {
  it('names every type, priority and status from the locale strings, in a stable order', () => {
    expect(getEventTypeOptions(labels).map((o) => o.value)).toEqual([
      'meeting',
      'call',
      'appointment',
      'event',
      'reminder',
      'other',
    ]);
    expect(getEventPriorityOptions(labels)).toEqual([
      { value: 'low', label: 'Laag' },
      { value: 'normal', label: 'Normaal' },
      { value: 'high', label: 'Hoog' },
      { value: 'urgent', label: 'Urgent' },
    ]);
    expect(getEventStatusOptions(labels)).toEqual([
      { value: 'confirmed', label: 'Bevestigd' },
      { value: 'tentative', label: 'Onder voorbehoud' },
      { value: 'cancelled', label: 'Geannuleerd' },
    ]);
  });

  it('calls a reminder a task, like the toolbar filter does', () => {
    expect(getEventTypeLabels(labels).reminder).toBe('Taak');
  });

  it('shows a value it does not know as is', () => {
    expect(labelFor(getEventTypeLabels(labels), 'birthday')).toBe('birthday');
    expect(labelFor(getEventTypeLabels(labels), 'call')).toBe('Gesprek');
    expect(labelFor(getEventTypeLabels(labels), null)).toBe('');
  });
});

describe('buildEventFormSchema', () => {
  const messages = {
    calendarRequired: 'cal!',
    titleRequired: 'title!',
    titleTooLong: 'long!',
    startRequired: 'start!',
    invalidMeetingUrl: 'url!',
    invalidGuestEmail: 'mail!',
  };
  const base = { calendarId: 'c1', title: 'T', startTime: new Date('2026-10-05T09:00:00Z') };

  it('uses the given messages', () => {
    const schema = buildEventFormSchema(messages);
    const result = schema.safeParse({
      calendarId: '',
      title: '',
      startTime: 'nope',
      meetingUrl: 'x y',
      attendees: [{ email: 'bad' }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const byPath = Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));
    expect(byPath.calendarId).toBe('cal!');
    expect(byPath.title).toBe('title!');
    expect(byPath.startTime).toBe('start!');
    expect(byPath.meetingUrl).toBe('url!');
    expect(byPath['attendees.0.email']).toBe('mail!');
  });

  it('accepts null for every column the API leaves unset', () => {
    const schema = buildEventFormSchema(messages);
    expect(
      schema.safeParse({ ...base, description: null, location: null, meetingUrl: null, attendees: null, tags: null }).success,
    ).toBe(true);
  });
});
