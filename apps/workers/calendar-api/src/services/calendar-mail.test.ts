/**
 * Attendee mail rendering: join link, guest vs member links, time zones, ICS.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateIcs,
  mailTimeZone,
  nextIcsSequence,
  renderCalendarCancelEmail,
  renderCalendarInviteEmail,
  renderCalendarRescheduleEmail,
  renderCalendarText,
  sendCalendarEventEmails,
  type CalendarMailEvent,
} from './calendar-mail';
import type { Env } from '../types';

const MEETING_URL = 'https://meet.weldsuite.org/acme/wm-dip-zfz-ubv';
const APP_LINK = 'https://app.weldsuite.org/weldcalendar';

// 23:00-24:00 in Europe/Amsterdam (CEST, UTC+2) on 1 October 2026.
const START = '2026-10-01T21:00:00.000Z';
const END = '2026-10-01T22:00:00.000Z';

const base = {
  organizerName: 'Gert',
  eventTitle: 'Planning',
  startTime: START,
  endTime: END,
  meetingUrl: MEETING_URL,
  timezone: 'Europe/Amsterdam',
};

/** Unfold RFC 5545 content lines. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

describe('calendar mail HTML', () => {
  it('invite shows a join button and the plain URL when the event has a meeting link', () => {
    const html = renderCalendarInviteEmail(base);
    expect(html).toContain('Join WeldMeet meeting');
    expect(html).toContain(`href="${MEETING_URL}"`);
    // The plain URL is also spelled out as text for clients that strip buttons.
    expect(html).toContain(`>${MEETING_URL}</a>`);
  });

  it('labels a third-party meeting link generically', () => {
    const html = renderCalendarInviteEmail({ ...base, meetingUrl: 'https://meet.google.com/abc-defg-hij' });
    expect(html).toContain('Join video meeting');
    expect(html).not.toContain('Join WeldMeet meeting');
  });

  it('has no link into the authenticated app when no eventUrl is given (external guest)', () => {
    const html = renderCalendarInviteEmail(base);
    expect(html).not.toContain('app.weldsuite.org');
    expect(html).not.toContain('View Event');
    expect(html).not.toContain('View in WeldCalendar');
  });

  it('keeps an app link as a secondary action for members', () => {
    const html = renderCalendarInviteEmail({ ...base, eventUrl: APP_LINK });
    expect(html).toContain('Join WeldMeet meeting');
    expect(html).toContain(`href="${APP_LINK}"`);
    expect(html).toContain('View in WeldCalendar');
  });

  it('members of an event without a meeting still get the View Event button', () => {
    const html = renderCalendarInviteEmail({ ...base, meetingUrl: undefined, eventUrl: APP_LINK });
    expect(html).toContain('View Event');
    expect(html).not.toContain('Join');
  });

  it('renders times in the event timezone, with the zone, not UTC', () => {
    const html = renderCalendarInviteEmail(base);
    expect(html).toContain('11:00 PM GMT+2');
    expect(html).toContain('12:00 AM GMT+2');
    expect(html).not.toContain('9:00 PM');
    expect(html).not.toContain('UTC');
  });

  it('shows the end date when the event crosses midnight', () => {
    const html = renderCalendarInviteEmail({ ...base, endTime: '2026-10-02T05:00:00.000Z' });
    expect(html).toContain('Thursday, October 1, 2026');
    expect(html).toContain('Friday, October 2, 2026');
  });

  it('falls back to UTC for a missing or invalid timezone', () => {
    expect(renderCalendarInviteEmail({ ...base, timezone: undefined })).toContain('9:00 PM UTC');
    expect(renderCalendarInviteEmail({ ...base, timezone: 'Not/AZone' })).toContain('9:00 PM UTC');
  });

  it('renders an all-day event as dates only', () => {
    const html = renderCalendarInviteEmail({
      ...base,
      allDay: true,
      startTime: '2026-09-30T22:00:00.000Z',
      endTime: '2026-10-01T21:59:59.000Z',
    });
    expect(html).toContain('Thursday, October 1, 2026 (all day)');
    expect(html).not.toContain('GMT+2');
  });

  it('reschedule mail carries the join link, the new time and the struck-through old time', () => {
    const html = renderCalendarRescheduleEmail({
      ...base,
      oldStartTime: '2026-09-30T08:00:00.000Z',
      oldEndTime: '2026-09-30T09:00:00.000Z',
    });
    expect(html).toContain('has rescheduled an event');
    expect(html).toContain('Join WeldMeet meeting');
    expect(html).toContain('11:00 PM GMT+2');
    expect(html).toContain('10:00 AM GMT+2');
    expect(html).not.toContain('View Event');
  });

  it('"updated" copy replaces "rescheduled" for a non-move update', () => {
    const html = renderCalendarRescheduleEmail({ ...base, updated: true });
    expect(html).toContain('has updated an event');
  });

  it('cancel mail has no join button and no app button', () => {
    const html = renderCalendarCancelEmail({ ...base, eventUrl: APP_LINK });
    expect(html).toContain('has cancelled an event');
    expect(html).not.toContain('Join');
    expect(html).not.toContain(MEETING_URL);
    expect(html).not.toContain('app.weldsuite.org');
  });

  it('escapes HTML in titles and the meeting URL', () => {
    const html = renderCalendarInviteEmail({
      ...base,
      eventTitle: '<script>x</script>',
      meetingUrl: 'https://meet.weldsuite.org/a"b',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;');
  });

  it('text body spells out the join URL', () => {
    const text = renderCalendarText('invite', base);
    expect(text).toContain(`Join WeldMeet meeting: ${MEETING_URL}`);
    expect(text).toContain('11:00 PM GMT+2');
    expect(text).not.toContain('weldcalendar');
    expect(renderCalendarText('cancel', base)).not.toContain(MEETING_URL);
  });
});

describe('mailTimeZone', () => {
  const event: CalendarMailEvent = { id: 'evt_1', title: 'x' };
  it('prefers the event zone, then the organizer zone, then UTC', () => {
    expect(mailTimeZone({ ...event, timezone: 'Asia/Tokyo' }, { name: '', email: '', timezone: 'Europe/Paris' })).toBe('Asia/Tokyo');
    expect(mailTimeZone(event, { name: '', email: '', timezone: 'Europe/Paris' })).toBe('Europe/Paris');
    expect(mailTimeZone(event, { name: '', email: '' })).toBe('UTC');
    expect(mailTimeZone({ ...event, timezone: 'bogus' }, { name: '', email: '' })).toBe('UTC');
  });
});

describe('generateIcs', () => {
  const params = {
    uid: 'evt_1@weldsuite.org',
    title: 'Planning',
    startTime: START,
    endTime: END,
    organizerName: 'Gert',
    organizerEmail: 'gert@acme.com',
    attendeeEmail: 'guest@example.com',
  };

  it('uses the meeting URL as LOCATION and URL when there is no physical location', () => {
    const ics = unfold(generateIcs({ ...params, meetingUrl: MEETING_URL }));
    expect(ics).toContain(`LOCATION:${MEETING_URL}`);
    expect(ics).toContain(`URL:${MEETING_URL}`);
    expect(ics).toContain(`Join: ${MEETING_URL}`);
    expect(ics).toContain(`X-GOOGLE-CONFERENCE:${MEETING_URL}`);
  });

  it('keeps a physical location and moves the meeting URL into DESCRIPTION', () => {
    const ics = unfold(generateIcs({ ...params, location: 'Room 4, Main St', meetingUrl: MEETING_URL }));
    expect(ics).toContain('LOCATION:Room 4\\, Main St');
    expect(ics).not.toContain(`LOCATION:${MEETING_URL}`);
    expect(ics).toContain(`DESCRIPTION:Join: ${MEETING_URL}`);
    expect(ics).toContain(`URL:${MEETING_URL}`);
  });

  it('writes DTSTART/DTEND in UTC with DTEND after DTSTART', () => {
    const ics = generateIcs(params);
    expect(ics).toContain('DTSTART:20261001T210000Z');
    expect(ics).toContain('DTEND:20261001T220000Z');
  });

  it('drops a DTEND that is not after DTSTART', () => {
    const ics = generateIcs({ ...params, endTime: '2026-09-30T22:00:00.000Z' });
    expect(ics).toContain('DTSTART:20261001T210000Z');
    expect(ics).not.toContain('DTEND');
  });

  it('writes all-day events as DATE values with an exclusive end', () => {
    const ics = generateIcs({
      ...params,
      allDay: true,
      timezone: 'Europe/Amsterdam',
      startTime: '2026-09-30T22:00:00.000Z',
      endTime: '2026-10-01T21:59:59.000Z',
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20261001');
    expect(ics).toContain('DTEND;VALUE=DATE:20261002');
  });

  it('escapes commas, semicolons, backslashes and newlines in text values', () => {
    const ics = unfold(
      generateIcs({ ...params, title: 'A, B; C\\D', description: 'line1\nline2\r\nline3' }),
    );
    expect(ics).toContain('SUMMARY:A\\, B\\; C\\\\D');
    expect(ics).toContain('DESCRIPTION:line1\\nline2\\nline3');
  });

  it('quotes the organizer CN so commas and colons survive', () => {
    const ics = generateIcs({ ...params, organizerName: 'Doe, John: CEO' });
    expect(ics).toContain('ORGANIZER;CN="Doe, John: CEO":mailto:gert@acme.com');
  });

  it('folds lines longer than 75 octets and uses CRLF throughout', () => {
    const ics = generateIcs({ ...params, description: 'x'.repeat(200) + 'é'.repeat(50) });
    const lines = ics.split('\r\n');
    const encoder = new TextEncoder();
    for (const line of lines) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(unfold(ics)).toContain(`DESCRIPTION:${'x'.repeat(200)}${'é'.repeat(50)}`);
  });

  it('CANCEL mail: METHOD CANCEL, STATUS CANCELLED and no join details', () => {
    const ics = generateIcs({ ...params, method: 'CANCEL', meetingUrl: MEETING_URL, sequence: 9 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:9');
    expect(ics).not.toContain(MEETING_URL);
  });
});

describe('sendCalendarEventEmails', () => {
  interface Sent {
    to: string[];
    subject: string;
    html?: string;
    text?: string;
    attachments: { content: string }[];
  }

  function stubResend(): Sent[] {
    const sent: Sent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body) as Sent);
        return new Response('{}', { status: 200 });
      }),
    );
    return sent;
  }

  const env = { RESEND_API_KEY: 're_test', ENVIRONMENT: 'production' } as unknown as Env;
  const organizer = { name: 'Gert', email: 'gert@acme.com', timezone: 'Europe/Amsterdam' };
  const event: CalendarMailEvent = {
    id: 'evt_1',
    title: 'Planning',
    startTime: START,
    endTime: END,
    meetingUrl: MEETING_URL,
  };

  afterEach(() => vi.unstubAllGlobals());

  it('invite: the guest gets the join link and no app link, the member gets both; organizer zone applies', async () => {
    const sent = stubResend();
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }, { email: 'Member@acme.com' }, { email: 'gert@acme.com' }],
      memberEmails: new Set(['member@acme.com']),
    });

    expect(sent.map((m) => m.to[0])).toEqual(['guest@example.com', 'Member@acme.com']);
    const [guest, member] = sent;

    expect(guest.html).toContain(`href="${MEETING_URL}"`);
    expect(guest.html).not.toContain('app.weldsuite.org');
    expect(guest.html).toContain('11:00 PM GMT+2');
    expect(guest.text).toContain(MEETING_URL);
    const guestIcs = unfold(guest.attachments[0].content);
    expect(guestIcs).toContain(`LOCATION:${MEETING_URL}`);
    expect(guestIcs).toContain(`URL:${MEETING_URL}`);
    expect(guestIcs).toContain('DTSTART:20261001T210000Z');

    expect(member.html).toContain(`href="${MEETING_URL}"`);
    expect(member.html).toContain(`href="${APP_LINK}"`);
  });

  it('treats everyone as a guest when no member list is given', async () => {
    const sent = stubResend();
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event: { ...event, meetingUrl: null },
      attendees: [{ email: 'someone@acme.com' }],
    });
    expect(sent[0].html).not.toContain('app.weldsuite.org');
  });

  it('event timezone wins over the organizer timezone', async () => {
    const sent = stubResend();
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event: { ...event, timezone: 'America/New_York' },
      attendees: [{ email: 'guest@example.com' }],
    });
    expect(sent[0].html).toContain('5:00 PM EDT');
  });

  it('honours an APP_URL override for member links', async () => {
    const sent = stubResend();
    await sendCalendarEventEmails({ ...env, APP_URL: 'https://calendar.example.com/' } as unknown as Env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'member@acme.com' }],
      memberEmails: new Set(['member@acme.com']),
    });
    expect(sent[0].html).toContain('href="https://calendar.example.com/weldcalendar"');
  });

  it('reschedule: REQUEST with a sequence above the invite, join link and new time', async () => {
    const sent = stubResend();
    await sendCalendarEventEmails(env, {
      kind: 'reschedule',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }],
      oldStartTime: '2026-09-30T08:00:00.000Z',
      oldEndTime: '2026-09-30T09:00:00.000Z',
      sequence: 2,
    });
    expect(sent[0].subject).toBe('Event rescheduled: Planning');
    expect(sent[0].html).toContain('Join WeldMeet meeting');
    const ics = sent[0].attachments[0].content;
    expect(ics).toContain('METHOD:REQUEST');
    const seq = Number(/SEQUENCE:(\d+)/.exec(ics)?.[1]);
    expect(seq).toBeGreaterThan(2);
    expect(seq).toBeLessThanOrEqual(nextIcsSequence());
  });

  it('cancel: METHOD CANCEL, a sequence that supersedes earlier revisions, no join link', async () => {
    const sent = stubResend();
    await sendCalendarEventEmails(env, {
      kind: 'cancel',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }],
      sequence: 3,
      memberEmails: new Set(['guest@example.com']),
    });
    const ics = sent[0].attachments[0].content;
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(Number(/SEQUENCE:(\d+)/.exec(ics)?.[1])).toBeGreaterThan(3);
    expect(sent[0].html).not.toContain(MEETING_URL);
    expect(sent[0].html).not.toContain('app.weldsuite.org');
    expect(ics).not.toContain(MEETING_URL);
  });

  it('a bad event time is logged per recipient and never throws', async () => {
    const sent = stubResend();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event: { ...event, startTime: 'garbage' },
      attendees: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    });
    expect(sent).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('no-ops without an API key', async () => {
    const sent = stubResend();
    await sendCalendarEventEmails({ ...env, RESEND_API_KEY: undefined } as unknown as Env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'a@example.com' }],
    });
    expect(sent).toHaveLength(0);
  });
});
