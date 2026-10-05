import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import {
  buildMeetingJoinUrl,
  getMeetingPortalUrl,
  mergeInvitees,
  normalizeInvitees,
  sendInvitationEmail,
  type ResolvedInvitee,
} from './invitations';
import type { Env } from '../../types';

const { sendSystemEmailMock } = vi.hoisted(() => ({ sendSystemEmailMock: vi.fn() }));

vi.mock('@weldsuite/emails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/emails')>();
  return { ...actual, sendSystemEmail: sendSystemEmailMock };
});

const guest = (email: string, extra: Partial<ResolvedInvitee> = {}): ResolvedInvitee => ({
  email,
  name: email,
  userId: '',
  ...extra,
});

describe('normalizeInvitees', () => {
  it('lowercases, trims and de-duplicates by email (first one wins)', () => {
    expect(
      normalizeInvitees([
        { email: ' WeldHost@Gmail.com ', name: ' Weld ' },
        { email: 'weldhost@gmail.com', name: 'Other' },
        { email: 'b@example.com' },
      ]),
    ).toEqual([
      { email: 'weldhost@gmail.com', name: 'Weld' },
      { email: 'b@example.com' },
    ]);
  });
});

describe('mergeInvitees', () => {
  const organizer: MeetingAttendee = {
    userId: 'user_org',
    email: 'org@acme.com',
    name: 'Org',
    status: 'accepted',
    role: 'organizer',
  };

  it('adds new invitees as pending attendees', () => {
    const result = mergeInvitees([organizer], [guest('weldhost@gmail.com', { personId: 'per_1' })]);
    expect(result.added).toEqual([
      {
        userId: '',
        email: 'weldhost@gmail.com',
        name: 'weldhost@gmail.com',
        status: 'pending',
        role: 'attendee',
        personId: 'per_1',
      },
    ]);
    expect(result.attendees).toHaveLength(2);
    expect(result.alreadyInvited).toEqual([]);
  });

  it('leaves existing attendees untouched (matched by email or user id)', () => {
    const result = mergeInvitees(
      [organizer],
      [guest('ORG@acme.com'.toLowerCase()), guest('other@acme.com', { userId: 'user_org' })],
    );
    expect(result.added).toEqual([]);
    expect(result.alreadyInvited).toEqual(['org@acme.com', 'other@acme.com']);
    expect(result.attendees).toEqual([organizer]);
  });

  it('promotes a walk-in guest to an invited attendee', () => {
    const walkIn: MeetingAttendee = {
      userId: 'guest:abc',
      email: 'walk@in.com',
      name: 'Walk In',
      status: 'accepted',
      role: 'attendee',
      source: 'walk_in',
    };
    const result = mergeInvitees([walkIn], [guest('walk@in.com')]);
    expect(result.added).toHaveLength(1);
    expect(result.attendees[0]?.source).toBeUndefined();
    expect(walkIn.source).toBe('walk_in');
  });
});

describe('join url', () => {
  it('defaults to the production portal and strips trailing slashes', () => {
    expect(getMeetingPortalUrl(undefined)).toBe('https://meet.weldsuite.org');
    expect(getMeetingPortalUrl('http://localhost:3020/')).toBe('http://localhost:3020');
    expect(buildMeetingJoinUrl('https://meet.weldsuite.org', 'org_1', 'wm-abc-def-ghi')).toBe(
      'https://meet.weldsuite.org/org_1/wm-abc-def-ghi',
    );
  });
});

describe('sendInvitationEmail', () => {
  const env = { RESEND_API_KEY: 're_test', ENVIRONMENT: 'production' } as unknown as Env;
  const base = {
    meeting: { id: 'mtg_1', title: 'Sync <script>', description: null },
    organizer: { name: 'Gert', email: 'gert@acme.com' },
    joinUrl: 'https://meet.weldsuite.org/org_1/wm-abc-def-ghi',
    attendee: { email: 'weldhost@gmail.com' },
  };

  afterEach(() => sendSystemEmailMock.mockReset());

  function lastCall() {
    const calls = sendSystemEmailMock.mock.calls as unknown as Array<
      [
        unknown,
        {
          template: string;
          props: Record<string, unknown>;
          to: string;
          replyTo?: string;
          attachments: { content: string; contentType?: string }[];
        },
      ]
    >;
    return calls[calls.length - 1];
  }

  it('sends the meet.invitation template with the join link and reply-to', async () => {
    const ok = await sendInvitationEmail(env, base);
    expect(ok).toBe(true);
    const [, options] = lastCall();
    expect(options.template).toBe('meet.invitation');
    expect(options.to).toBe('weldhost@gmail.com');
    expect(options.replyTo).toBe('gert@acme.com');
    expect(options.props).toMatchObject({
      organizerName: 'Gert',
      title: 'Sync <script>',
      joinUrl: base.joinUrl,
    });
  });

  it('builds an .ics only when the meeting is scheduled, one hour by default when there is no end', async () => {
    await sendInvitationEmail(env, base);
    expect(lastCall()[1].attachments).toEqual([]);

    await sendInvitationEmail(env, {
      ...base,
      meeting: { ...base.meeting, scheduledStart: '2026-10-05T09:00:00.000Z' },
    });
    const [, options] = lastCall();
    const unfolded = options.attachments[0].content.replace(/\r\n /g, '');
    expect(unfolded).toContain('DTSTART:20261005T090000Z');
    // No end time → one hour.
    expect(unfolded).toContain('DTEND:20261005T100000Z');
    expect(unfolded).toContain('mailto:weldhost@gmail.com');
    expect(unfolded).toContain('UID:mtg_1@meet.weldsuite.org');
    expect(unfolded).toContain('METHOD:REQUEST');
    expect(options.attachments[0].contentType).toContain('text/calendar');
  });

  it('falls back to the sender address for the ICS organizer when the organizer has no email', async () => {
    await sendInvitationEmail(env, {
      ...base,
      organizer: { name: 'Gert', email: '' },
      meeting: { ...base.meeting, scheduledStart: '2026-10-05T09:00:00.000Z' },
    });
    const [, options] = lastCall();
    const unfolded = options.attachments[0].content.replace(/\r\n /g, '');
    expect(unfolded).toContain('ORGANIZER;CN="Gert":mailto:notifications@mail.weldsuite.org');
    expect(options.replyTo).toBeUndefined();
  });

  it('passes the organizer timezone through to the template', async () => {
    await sendInvitationEmail(env, {
      ...base,
      organizer: { ...base.organizer, timezone: 'Europe/Amsterdam' },
    });
    expect(lastCall()[1].props.timezone).toBe('Europe/Amsterdam');
  });

  it('no-ops without any email transport configured, and never throws', async () => {
    const ok = await sendInvitationEmail({ ...env, RESEND_API_KEY: undefined } as unknown as Env, base);
    expect(ok).toBe(false);
    expect(sendSystemEmailMock).not.toHaveBeenCalled();
  });

  it('returns false and logs instead of throwing when the send fails', async () => {
    sendSystemEmailMock.mockRejectedValueOnce(new Error('boom'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await sendInvitationEmail(env, base);
    expect(ok).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
