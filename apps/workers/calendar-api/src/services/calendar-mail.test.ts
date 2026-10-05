/**
 * Calendar attendee mail: organizer/member lookups stay local; rendering, i18n
 * and ICS now live in `@weldsuite/emails` (tested there). This file checks the
 * plumbing: which template + props + attachment + recipients + locale
 * `sendCalendarEventEmails` hands to `sendSystemEmail`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendSystemEmailMock } = vi.hoisted(() => ({ sendSystemEmailMock: vi.fn() }));

vi.mock('@weldsuite/emails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/emails')>();
  return { ...actual, sendSystemEmail: sendSystemEmailMock };
});

import {
  mailTimeZone,
  sendCalendarEventEmails,
  type CalendarMailEvent,
} from './calendar-mail';
import type { Env } from '../types';

const MEETING_URL = 'https://meet.weldsuite.org/acme/wm-dip-zfz-ubv';
const APP_LINK = 'https://app.weldsuite.org/weldcalendar';

const START = '2026-10-01T21:00:00.000Z';
const END = '2026-10-01T22:00:00.000Z';

/** Unfold RFC 5545 content lines. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

describe('mailTimeZone', () => {
  const event: CalendarMailEvent = { id: 'evt_1', title: 'x' };
  it('prefers the event zone, then the organizer zone, then UTC', () => {
    expect(mailTimeZone({ ...event, timezone: 'Asia/Tokyo' }, { name: '', email: '', timezone: 'Europe/Paris' })).toBe('Asia/Tokyo');
    expect(mailTimeZone(event, { name: '', email: '', timezone: 'Europe/Paris' })).toBe('Europe/Paris');
    expect(mailTimeZone(event, { name: '', email: '' })).toBe('UTC');
    expect(mailTimeZone({ ...event, timezone: 'bogus' }, { name: '', email: '' })).toBe('UTC');
  });
});

describe('sendCalendarEventEmails', () => {
  const env = { RESEND_API_KEY: 're_test', ENVIRONMENT: 'production' } as unknown as Env;
  const organizer = { name: 'Gert', email: 'gert@acme.com', timezone: 'Europe/Amsterdam' };
  const event: CalendarMailEvent = {
    id: 'evt_1',
    title: 'Planning',
    startTime: START,
    endTime: END,
    meetingUrl: MEETING_URL,
  };

  afterEach(() => sendSystemEmailMock.mockReset());

  function calls() {
    return sendSystemEmailMock.mock.calls as unknown as Array<
      [unknown, { template: string; props: Record<string, unknown>; to: string; locale: string; replyTo?: string; attachments: { content: string }[] }]
    >;
  }

  it('invite: mails every attendee but the organizer, with the calendar.event template and a REQUEST ics', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }, { email: 'gert@acme.com' }],
    });

    const sent = calls();
    expect(sent).toHaveLength(1);
    const [, options] = sent[0];
    expect(options.template).toBe('calendar.event');
    expect(options.to).toBe('guest@example.com');
    expect(options.props).toMatchObject({ kind: 'invite', organizerName: 'Gert', title: 'Planning', meetingUrl: MEETING_URL });
    expect(options.replyTo).toBe('gert@acme.com');
    const ics = unfold(options.attachments[0].content);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toContain(`UID:${event.id}@weldsuite.org`);
    expect(ics).toContain(`LOCATION:${MEETING_URL}`);
  });

  it('gives the member an eventUrl, the guest none; organizer zone applies', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }, { email: 'Member@acme.com' }],
      memberEmails: new Map([['member@acme.com', {}]]),
    });

    const [guestCall, memberCall] = calls();
    expect(guestCall[1].props.eventUrl).toBeUndefined();
    expect(memberCall[1].props.eventUrl).toBe(APP_LINK);
    expect(memberCall[1].props.timezone).toBe('Europe/Amsterdam');
  });

  it('resolves locale from the member language, else the workspace language, else default', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [
        { email: 'dutch-member@acme.com' },
        { email: 'other-member@acme.com' },
        { email: 'guest@example.com' },
      ],
      memberEmails: new Map([
        ['dutch-member@acme.com', { language: 'nl' }],
        ['other-member@acme.com', {}],
      ]),
      workspaceLanguage: 'nl',
    });

    const sent = calls();
    expect(sent.map(([, o]) => o.locale)).toEqual(['nl', 'nl', 'nl']);
  });

  it('defaults locale to en without a member language or a workspace language', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }],
    });
    expect(calls()[0][1].locale).toBe('en');
  });

  it('honours an APP_URL override for member links', async () => {
    await sendCalendarEventEmails({ ...env, APP_URL: 'https://calendar.example.com/' } as unknown as Env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'member@acme.com' }],
      memberEmails: new Map([['member@acme.com', {}]]),
    });
    expect(calls()[0][1].props.eventUrl).toBe('https://calendar.example.com/weldcalendar');
  });

  it('reschedule: REQUEST with a sequence above the floor, and the old time in props', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'reschedule',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }],
      oldStartTime: '2026-09-30T08:00:00.000Z',
      oldEndTime: '2026-09-30T09:00:00.000Z',
      sequence: 2,
    });
    const [, options] = calls()[0];
    expect(options.props).toMatchObject({ kind: 'reschedule', oldStartTime: '2026-09-30T08:00:00.000Z' });
    const ics = options.attachments[0].content;
    expect(ics).toContain('METHOD:REQUEST');
    const seq = Number(/SEQUENCE:(\d+)/.exec(ics)?.[1]);
    expect(seq).toBeGreaterThan(2);
  });

  it('cancel: METHOD CANCEL, a sequence that supersedes earlier revisions, no meeting/event link', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'cancel',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }],
      sequence: 3,
      memberEmails: new Map([['guest@example.com', {}]]),
    });
    const [, options] = calls()[0];
    expect(options.props.meetingUrl).toBeUndefined();
    expect(options.props.eventUrl).toBeUndefined();
    const ics = options.attachments[0].content;
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(Number(/SEQUENCE:(\d+)/.exec(ics)?.[1])).toBeGreaterThan(3);
    expect(ics).not.toContain(MEETING_URL);
  });

  it('removed: its own kind, still a CANCEL ics that supersedes earlier revisions', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'removed',
      organizer,
      event,
      attendees: [{ email: 'guest@example.com' }],
      memberEmails: new Map([['guest@example.com', {}]]),
    });
    const [, options] = calls()[0];
    expect(options.props.kind).toBe('removed');
    expect(options.props.meetingUrl).toBeUndefined();
    const ics = options.attachments[0].content;
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(Number(/SEQUENCE:(\d+)/.exec(ics)?.[1])).toBeGreaterThan(0);
  });

  it('event timezone wins over the organizer timezone', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event: { ...event, timezone: 'America/New_York' },
      attendees: [{ email: 'guest@example.com' }],
    });
    expect(calls()[0][1].props.timezone).toBe('America/New_York');
  });

  it('a bad event time is logged per recipient and never throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event: { ...event, startTime: 'garbage' },
      attendees: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    });
    expect(sendSystemEmailMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('no-ops without any email transport configured', async () => {
    await sendCalendarEventEmails({ ...env, RESEND_API_KEY: undefined } as unknown as Env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'a@example.com' }],
    });
    expect(sendSystemEmailMock).not.toHaveBeenCalled();
  });

  it('no-ops without attendees', async () => {
    await sendCalendarEventEmails(env, { kind: 'invite', organizer, event, attendees: [] });
    expect(sendSystemEmailMock).not.toHaveBeenCalled();
  });

  it('skips the organizer and blank addresses', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer,
      event,
      attendees: [{ email: 'gert@acme.com' }, { email: '' }, { email: undefined }],
    });
    expect(sendSystemEmailMock).not.toHaveBeenCalled();
  });

  it('omits replyTo when the organizer has no email', async () => {
    await sendCalendarEventEmails(env, {
      kind: 'invite',
      organizer: { name: 'Someone', email: '' },
      event,
      attendees: [{ email: 'guest@example.com' }],
    });
    expect(calls()[0][1].replyTo).toBeUndefined();
  });
});
