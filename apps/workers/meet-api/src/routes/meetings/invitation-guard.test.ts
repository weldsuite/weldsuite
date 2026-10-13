/**
 * POST /api/meetings/:id/invitations and the outbound mail guard.
 *
 * Each invitation goes out from WeldSuite's own address with the organizer's
 * title and description, so a batch of them goes through the guard first
 * (docs/plans/weldmail-outbound-abuse.md). What must hold:
 *   - the guard is asked once per batch, with the Clerk org id and only the
 *     people who are newly invited (an existing attendee is not mailed again);
 *   - when it refuses, the attendees are still saved, nobody is mailed and
 *     every invitee reports `emailSent: false`;
 *   - when it allows, the invitations go out and the batch is committed;
 *   - `sendEmail: false` never reaches the guard.
 * The guard is faked (its own tests live in @weldsuite/mail-domain); mail is
 * observed by stubbing the Resend `fetch`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { meetingsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { OutboundDeniedError } from '@weldsuite/mail-domain/outbound';

const { checkOutboundMock, commitOutboundMock, releaseOutboundMock } = vi.hoisted(() => ({
  checkOutboundMock: vi.fn(),
  commitOutboundMock: vi.fn(),
  releaseOutboundMock: vi.fn(),
}));

// The real OutboundDeniedError; the three calls that talk to the ledger are faked.
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>();
  return {
    ...actual,
    checkOutbound: checkOutboundMock,
    commitOutbound: commitOutboundMock,
    releaseOutbound: releaseOutboundMock,
  };
});

const ORGANIZER = 'user_invite_guard_org';
const ORG_ID = 'org_invite_guard';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

let sent: Array<{ to: string[] }> = [];

beforeEach(() => {
  sent = [];
  checkOutboundMock.mockResolvedValue({ ledger: null, reservationId: 'res_1', recipients: [], mode: 'enforce' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as { to: string[] });
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  checkOutboundMock.mockReset();
  commitOutboundMock.mockReset();
  releaseOutboundMock.mockReset();
  vi.restoreAllMocks();
});

function request(permission: string, path: string, body: unknown) {
  return createTestApp('/api/meetings', meetingsRoutes, {
    context: { permissions: permissions(permission), userId: ORGANIZER, orgId: ORG_ID, workspaceId: ORG_ID, tenantDb: db },
    env: { RESEND_API_KEY: 're_test', ENVIRONMENT: 'production' },
  }).request(`/api/meetings${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedMeeting(): Promise<string> {
  const res = await request('meetings:create', '', { title: 'Guard test', accessType: 'anyone_with_link' });
  return ((await res.json()) as { data: { id: string } }).data.id;
}

const invite = (meetingId: string, body: unknown) => request('meetings:update', `/${meetingId}/invitations`, body);

async function attendeesOf(meetingId: string) {
  const [row] = await db
    .select({ attendees: schema.meetings.attendees })
    .from(schema.meetings)
    .where(eq(schema.meetings.id, meetingId))
    .limit(1);
  return row?.attendees ?? [];
}

interface InviteBody {
  data: { invited: { email: string; emailSent: boolean }[]; alreadyInvited: string[] };
}

describe('invitations and the outbound guard', () => {
  it('asks the guard once, with the org id and the newly invited people, and commits after the mails go out', async () => {
    const meetingId = await seedMeeting();
    const res = await invite(meetingId, { invitees: [{ email: 'a@example.com' }, { email: 'B@Example.com' }] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as InviteBody;
    expect(body.data.invited.map((i) => [i.email, i.emailSent])).toEqual([
      ['a@example.com', true],
      ['b@example.com', true],
    ]);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['a@example.com', 'b@example.com']);

    expect(checkOutboundMock).toHaveBeenCalledTimes(1);
    const [, , input] = checkOutboundMock.mock.calls[0]!;
    expect(input).toMatchObject({
      subject: { kind: 'workspace', clerkOrgId: ORG_ID },
      source: 'meet',
      kind: 'new_thread',
      systemSender: true,
      subjectLine: 'Guard test',
      to: ['a@example.com', 'b@example.com'],
    });
    expect(commitOutboundMock).toHaveBeenCalledTimes(1);
    expect(releaseOutboundMock).not.toHaveBeenCalled();
  });

  it('a refused batch keeps the attendees saved, mails nobody and reports emailSent: false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkOutboundMock.mockRejectedValue(new OutboundDeniedError({ code: 'SENDING_ON_HOLD', reason: 'under_review' }));
    const meetingId = await seedMeeting();

    const res = await invite(meetingId, { invitees: [{ email: 'a@example.com' }, { email: 'b@example.com' }] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as InviteBody;
    expect(body.data.invited.map((i) => i.emailSent)).toEqual([false, false]);
    expect(await attendeesOf(meetingId)).toHaveLength(2);
    expect(sent).toHaveLength(0);
    expect(commitOutboundMock).not.toHaveBeenCalled();
    // The route logs other warnings too (participant lookups); look for the refusal.
    expect(warn.mock.calls.some(([message]) => String(message).includes('SENDING_ON_HOLD'))).toBe(true);
  });

  it('does not mail, or count, someone who is already invited', async () => {
    const meetingId = await seedMeeting();
    await invite(meetingId, { invitees: [{ email: 'a@example.com' }] });
    checkOutboundMock.mockClear();
    commitOutboundMock.mockClear();
    sent = [];

    const res = await invite(meetingId, { invitees: [{ email: 'a@example.com' }, { email: 'b@example.com' }] });

    const body = (await res.json()) as InviteBody;
    expect(body.data.alreadyInvited).toEqual(['a@example.com']);
    expect(checkOutboundMock).toHaveBeenCalledTimes(1);
    expect(checkOutboundMock.mock.calls[0]![2].to).toEqual(['b@example.com']);
    expect(sent.map((m) => m.to[0])).toEqual(['b@example.com']);
  });

  it('sendEmail: false never reaches the guard', async () => {
    const meetingId = await seedMeeting();
    const res = await invite(meetingId, { invitees: [{ email: 'quiet@example.com' }], sendEmail: false });

    expect(res.status).toBe(200);
    const body = (await res.json()) as InviteBody;
    expect(body.data.invited.map((i) => i.emailSent)).toEqual([false]);
    expect(await attendeesOf(meetingId)).toHaveLength(1);
    expect(checkOutboundMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
