import { describe, it, expect } from 'vitest';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import { applyEventAttendeeChange } from './calendar-meeting-sync';

const organizer: MeetingAttendee = {
  userId: 'user_org',
  email: 'org@acme.com',
  name: 'Organizer',
  status: 'accepted',
  role: 'organizer',
};
const walkIn: MeetingAttendee = {
  userId: '',
  email: 'walkin@example.com',
  name: 'Walk In',
  status: 'pending',
  role: 'attendee',
  source: 'walk_in',
};
const invited: MeetingAttendee = {
  userId: 'user_inv',
  email: 'invited@example.com',
  name: 'Invited',
  status: 'accepted',
  role: 'attendee',
};

describe('applyEventAttendeeChange', () => {
  it('reports no change when the event attendees are the same', () => {
    const list = [{ email: 'a@x.com' }, { email: 'b@x.com' }];
    const current = [organizer, invited];
    const result = applyEventAttendeeChange(current, list, [{ email: 'B@x.com' }, { email: 'a@x.com' }]);
    expect(result.changed).toBe(false);
    expect(result.attendees).toBe(current);
  });

  it('adds people new to the event as pending attendees', () => {
    const result = applyEventAttendeeChange(
      [organizer],
      [{ email: 'a@x.com' }],
      [{ email: 'a@x.com' }, { email: 'New@X.com', name: 'New Person' }, { email: 'bare@x.com' }],
    );
    expect(result.changed).toBe(true);
    expect(result.attendees).toEqual([
      organizer,
      { userId: '', email: 'new@x.com', name: 'New Person', status: 'pending', role: 'attendee' },
      { userId: '', email: 'bare@x.com', name: 'bare@x.com', status: 'pending', role: 'attendee' },
    ]);
  });

  it('removes only people who were on the old event list', () => {
    const onEvent: MeetingAttendee = {
      userId: 'user_a',
      email: 'a@x.com',
      name: 'A',
      status: 'accepted',
      role: 'attendee',
    };
    const result = applyEventAttendeeChange(
      [organizer, onEvent, invited, walkIn],
      [{ email: 'a@x.com' }, { email: 'gone-already@x.com' }],
      [],
    );
    expect(result.changed).toBe(true);
    // a@x.com is dropped; organizer, meet-api invitee and walk-in survive.
    expect(result.attendees).toEqual([organizer, invited, walkIn]);
  });

  it('never removes the organizer or a walk-in even if their email was on the event', () => {
    const result = applyEventAttendeeChange(
      [organizer, walkIn],
      [{ email: 'org@acme.com' }, { email: 'walkin@example.com' }],
      [],
    );
    expect(result.attendees).toEqual([organizer, walkIn]);
    expect(result.changed).toBe(false);
  });

  it('keeps RSVP and user id of attendees that stay, and does not duplicate existing emails', () => {
    const result = applyEventAttendeeChange(
      [invited],
      [{ email: 'x@x.com' }],
      [{ email: 'x@x.com' }, { email: 'INVITED@example.com' }],
    );
    // invited@ was added to the event but is already on the meeting: untouched.
    expect(result.changed).toBe(false);
    expect(result.attendees).toEqual([invited]);
  });

  it('handles null attendee lists on either side', () => {
    expect(applyEventAttendeeChange([invited], null, null).changed).toBe(false);
    const added = applyEventAttendeeChange([], null, [{ email: 'a@x.com' }]);
    expect(added.attendees).toHaveLength(1);
    const removed = applyEventAttendeeChange(
      [{ ...invited, email: 'a@x.com' }],
      [{ email: 'a@x.com' }],
      null,
    );
    expect(removed.attendees).toEqual([]);
  });
});
