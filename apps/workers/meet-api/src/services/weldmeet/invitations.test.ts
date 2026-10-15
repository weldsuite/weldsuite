import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import type { Database } from '@weldsuite/worker-kit/db';
import { OutboundDeniedError } from '@weldsuite/mail-domain/outbound';
import {
  buildMeetingJoinUrl,
  getMeetingPortalUrl,
  mergeInvitees,
  normalizeInvitees,
  sendInvitationEmail,
  sendInvitationEmails,
  type ResolvedInvitee,
} from './invitations';
import type { Env } from '../../types';

const { sendSystemEmailMock, checkOutboundMock, commitOutboundMock, releaseOutboundMock } = vi.hoisted(() => ({
  sendSystemEmailMock: vi.fn(),
  checkOutboundMock: vi.fn(),
  commitOutboundMock: vi.fn(),
  releaseOutboundMock: vi.fn(),
}));

vi.mock('@weldsuite/emails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/emails')>();
  return { ...actual, sendSystemEmail: sendSystemEmailMock };
});

// The real OutboundDeniedError (invitations tell a refusal apart by class);
// the three calls that talk to the ledger are faked. The guard itself is tested
// in @weldsuite/mail-domain (docs/plans/weldmail-outbound-abuse.md).
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>();
  return {
    ...actual,
    checkOutbound: checkOutboundMock,
    commitOutbound: commitOutboundMock,
    releaseOutbound: releaseOutboundMock,
  };
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

describe('sendInvitationEmails (the outbound guard)', () => {
  const env = { RESEND_API_KEY: 're_test', ENVIRONMENT: 'production' } as unknown as Env;
  const outbound = { db: {} as Database, clerkOrgId: 'org_1' };
  const reservation = {
    ledger: null,
    reservationId: 'res_1',
    sender: '',
    recipients: [],
    firstContact: [],
    mode: 'enforce',
  };
  const base = {
    meeting: { id: 'mtg_1', title: 'Sync', description: 'Agenda in the doc' },
    organizer: { name: 'Gert', email: 'gert@acme.com' },
    joinUrl: 'https://meet.weldsuite.org/org_1/wm-abc-def-ghi',
    attendees: [{ email: 'a@example.com', name: 'Anna' }, { email: 'b@example.com' }],
    outbound,
  };

  afterEach(() => {
    sendSystemEmailMock.mockReset();
    checkOutboundMock.mockReset();
    commitOutboundMock.mockReset();
    releaseOutboundMock.mockReset();
    vi.restoreAllMocks();
  });

  it('is asked once for the whole batch, as a system-sender meet mail to the invitees', async () => {
    checkOutboundMock.mockResolvedValue(reservation);
    const results = await sendInvitationEmails(env, base);

    expect(results).toEqual([true, true]);
    expect(checkOutboundMock).toHaveBeenCalledTimes(1);
    const [, db, input] = checkOutboundMock.mock.calls[0]!;
    expect(db).toBe(outbound.db);
    expect(input).toMatchObject({
      subject: { kind: 'workspace', clerkOrgId: 'org_1' },
      source: 'meet',
      kind: 'new_thread',
      systemSender: true,
      to: ['a@example.com', 'b@example.com'],
      subjectLine: 'Sync',
      text: 'Agenda in the doc',
      recipientNames: ['Anna'],
    });
    expect(sendSystemEmailMock).toHaveBeenCalledTimes(2);
  });

  it('commits the reservation once every mail went out', async () => {
    checkOutboundMock.mockResolvedValue(reservation);
    await sendInvitationEmails(env, base);
    expect(commitOutboundMock).toHaveBeenCalledTimes(1);
    expect(commitOutboundMock).toHaveBeenCalledWith(env, outbound.db, reservation, {});
    expect(releaseOutboundMock).not.toHaveBeenCalled();
  });

  it('reports each invitee, and commits only the ones that got their mail when a send fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    checkOutboundMock.mockResolvedValue(reservation);
    sendSystemEmailMock.mockImplementation(async (_transport: unknown, options: { to: string }) => {
      if (options.to === 'a@example.com') throw new Error('mailbox full');
    });

    const results = await sendInvitationEmails(env, base);

    expect(results).toEqual([false, true]);
    expect(commitOutboundMock).toHaveBeenCalledWith(env, outbound.db, reservation, {
      sentRecipients: ['b@example.com'],
    });
  });

  it('releases the reservation when no mail went out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    checkOutboundMock.mockResolvedValue(reservation);
    sendSystemEmailMock.mockRejectedValue(new Error('transport down'));

    expect(await sendInvitationEmails(env, base)).toEqual([false, false]);
    expect(releaseOutboundMock).toHaveBeenCalledWith(env, reservation);
    expect(commitOutboundMock).not.toHaveBeenCalled();
  });

  it('skips the whole batch when the guard refuses, reports every invitee as not mailed, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkOutboundMock.mockRejectedValue(
      new OutboundDeniedError({ code: 'FIRST_CONTACT_LIMITED', window: 'day', limit: 50, used: 50 }),
    );

    expect(await sendInvitationEmails(env, base)).toEqual([false, false]);

    expect(sendSystemEmailMock).not.toHaveBeenCalled();
    expect(commitOutboundMock).not.toHaveBeenCalled();
    expect(releaseOutboundMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('FIRST_CONTACT_LIMITED');
    expect(String(warn.mock.calls[0]![0])).toContain('mtg_1');
  });

  it('lets the mail through when the guard itself breaks (it fails open)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkOutboundMock.mockRejectedValue(new Error('ledger bug'));

    expect(await sendInvitationEmails(env, base)).toEqual([true, true]);

    expect(sendSystemEmailMock).toHaveBeenCalledTimes(2);
    // Nothing was reserved, so there is nothing to commit or give back.
    expect(commitOutboundMock).not.toHaveBeenCalled();
    expect(releaseOutboundMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('is not asked, and sends nothing, without invitees', async () => {
    expect(await sendInvitationEmails(env, { ...base, attendees: [] })).toEqual([]);
    expect(checkOutboundMock).not.toHaveBeenCalled();
    expect(sendSystemEmailMock).not.toHaveBeenCalled();
  });

  it('is not asked without an email transport', async () => {
    const results = await sendInvitationEmails({ ...env, RESEND_API_KEY: undefined } as unknown as Env, base);
    expect(results).toEqual([false, false]);
    expect(checkOutboundMock).not.toHaveBeenCalled();
  });
});
