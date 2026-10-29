/**
 * /api/calendar-events: the attendee cap and the outbound mail guard.
 *
 * Every attendee is mailed an invitation from WeldSuite's own address, so an
 * event carries at most 100 of them, and each batch of invitations goes through
 * the outbound guard first (docs/plans/weldmail-outbound-abuse.md). What must
 * hold:
 *   - 101 attendees is a 400, on create and on update; 100 is fine;
 *   - the guard is asked once per batch with the workspace's Clerk org id;
 *   - when the guard refuses, the event is still saved and nobody is mailed;
 *   - when it allows, the invitations go out and the batch is committed.
 * The guard is faked (its own tests live in @weldsuite/mail-domain); mail is
 * observed by stubbing the Resend `fetch`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { calendarEventsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
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

const USER_ID = 'user_invitation_guard';
const ORG_ID = 'org_invitation_guard';

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
});

async function seedCalendar(): Promise<string> {
  const id = generateId('cal');
  const now = new Date();
  await db.insert(schema.calendars).values({
    id,
    name: 'Guard calendar',
    ownerId: USER_ID,
    isDefault: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function request(method: string, path: string, body: unknown) {
  return createTestApp('/api/calendar-events', calendarEventsRoutes, {
    context: {
      permissions: permissions('events:read', 'events:create', 'events:update'),
      userId: USER_ID,
      orgId: ORG_ID,
      clerkOrgId: ORG_ID,
      tenantDb: db,
    },
    env: { RESEND_API_KEY: 're_test', ENVIRONMENT: 'production' },
  }).request(`/api/calendar-events${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const attendees = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `guest${i}@example.com` }));

async function createBody(extra: Record<string, unknown> = {}) {
  return {
    calendarId: await seedCalendar(),
    title: 'Planning',
    startTime: '2030-03-01T10:00:00.000Z',
    endTime: '2030-03-01T11:00:00.000Z',
    ...extra,
  };
}

/** Wait for a fire-and-forget mail batch to reach `count` sends. */
async function waitForMails(count: number): Promise<void> {
  for (let i = 0; i < 60 && sent.length < count; i++) await new Promise((r) => setTimeout(r, 50));
}

describe('the attendee cap', () => {
  it('create refuses 101 attendees with 400 and asks the guard nothing', async () => {
    const res = await request('POST', '', await createBody({ attendees: attendees(101) }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('100');
    expect(checkOutboundMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('update refuses 101 attendees with 400', async () => {
    const created = await request('POST', '', await createBody());
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const res = await request('PATCH', `/${id}`, { attendees: attendees(101) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('100');
  });

  it('applies the cap to the list as sent, before duplicates are collapsed', async () => {
    // 101 entries, one of them a duplicate of another: still refused.
    const list = [...attendees(100), { email: 'GUEST0@example.com' }];
    expect((await request('POST', '', await createBody({ attendees: list }))).status).toBe(400);
  });
});

describe('the outbound guard on invitations', () => {
  it('a refused batch keeps the event saved, with all 100 attendees, and mails nobody', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkOutboundMock.mockRejectedValue(
      new OutboundDeniedError({ code: 'SENDING_LIMITED', window: 'hour', limit: 30, used: 30 }),
    );

    const res = await request('POST', '', await createBody({ attendees: attendees(100) }));
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;

    const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
    expect(row!.attendees).toHaveLength(100);

    // The batch is asked about once, in the background, then skipped.
    for (let i = 0; i < 60 && checkOutboundMock.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(checkOutboundMock).toHaveBeenCalledTimes(1);
    const [, , input] = checkOutboundMock.mock.calls[0]!;
    expect(input).toMatchObject({
      subject: { kind: 'workspace', clerkOrgId: ORG_ID },
      source: 'calendar',
      kind: 'new_thread',
      systemSender: true,
    });
    expect(input.to).toHaveLength(100);

    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(0);
    expect(commitOutboundMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an allowed batch is mailed and committed', async () => {
    const res = await request('POST', '', await createBody({ attendees: attendees(2) }));
    expect(res.status).toBe(201);

    await waitForMails(2);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['guest0@example.com', 'guest1@example.com']);
    expect(checkOutboundMock).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60 && commitOutboundMock.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(commitOutboundMock).toHaveBeenCalledTimes(1);
    expect(releaseOutboundMock).not.toHaveBeenCalled();
  });

  it('a refused update still saves the new attendees', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const created = await request('POST', '', await createBody());
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    checkOutboundMock.mockRejectedValue(new OutboundDeniedError({ code: 'SENDING_SUSPENDED', reason: 'staff_suspension' }));
    const res = await request('PATCH', `/${id}?sendNotification=true`, { attendees: attendees(3) });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
    expect(row!.attendees).toHaveLength(3);
    for (let i = 0; i < 60 && checkOutboundMock.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(0);
    warn.mockRestore();
  });
});
