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
 * The guard runs for real; its ledger (`OUTBOUND_LEDGER`) is a stub that
 * allows or refuses, and the workspace resolves through a master pglite. In
 * conformance mode the Rust server's guard asks the same stub (the ledger
 * bridge), and both runs' ledger calls are compared. Mail is observed on a
 * `SEND_EMAIL` stub.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { calendarEventsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import { generateId } from '@weldsuite/worker-kit/id';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { readSent } from '../../test/sent-mail';

/** The `SEND_EMAIL` binding the routes send through. */
const mail = { stub: createSendEmailStub() };

const USER_ID = 'user_invitation_guard';
const ORG_ID = 'org_invitation_guard';
const WORKSPACE_ID = 'ws_invitation_guard';

// The guard resolves the workspace through the master database.
const masters = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(masters.db),
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => {
      if (orgId !== ORG_ID) throw new Error(`workspace not found: ${orgId}`);
      return { id: WORKSPACE_ID, clerkOrgId: ORG_ID };
    },
  };
});

type LedgerDecision = {
  allow: boolean;
  mode: 'enforce';
  reservationId: string | null;
  denial?: Record<string, unknown>;
};
const ALLOW: LedgerDecision = { allow: true, mode: 'enforce', reservationId: 'res_1' };

/**
 * The workspace's `OUTBOUND_LEDGER`: `reserve` answers `decision`. Both runs
 * call it in conformance mode, so the assertions read every call alike.
 */
const ledger = {
  decision: ALLOW,
  calls: { reserve: [] as unknown[][], commit: [] as unknown[][], release: [] as unknown[][] },
};
const stub = {
  reserve: async (...args: unknown[]) => {
    ledger.calls.reserve.push(args);
    return ledger.decision;
  },
  commit: async (...args: unknown[]) => {
    ledger.calls.commit.push(args);
  },
  release: async (...args: unknown[]) => {
    ledger.calls.release.push(args);
  },
};
const namespace = { idFromName: (name: string) => name, get: () => stub };

let db: Database;
let master: MasterDatabase;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  masters.db = master;
  await master.insert(masterSchema.workspaces).values({
    id: WORKSPACE_ID,
    name: 'Guard',
    slug: 'guard',
    clerkOrgId: ORG_ID,
  } as typeof masterSchema.workspaces.$inferInsert);
}, 120_000);

beforeEach(() => {
  mail.stub = createSendEmailStub();
  ledger.decision = ALLOW;
  for (const list of Object.values(ledger.calls)) list.length = 0;
});

/** The mail sent so far. */
const sent = () => readSent(mail.stub);

/** The reserve requests the guard sent (`[subject, request]` per call). */
const reserved = () => ledger.calls.reserve.map((args) => args[1] as { source: string; kind: string; recipients: string[] });

afterEach(() => {
  vi.restoreAllMocks();
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
      masterDb: master as unknown as Database,
    },
    env: { ENVIRONMENT: 'production', SEND_EMAIL: mail.stub as never, OUTBOUND_LEDGER: namespace as never },
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
  for (let i = 0; i < 60 && sent().length < count; i++) await new Promise((r) => setTimeout(r, 50));
}

describe('the attendee cap', () => {
  it('create refuses 101 attendees with 400 and asks the guard nothing', async () => {
    const res = await request('POST', '', await createBody({ attendees: attendees(101) }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('100');
    expect(ledger.calls.reserve).toHaveLength(0);
    expect(sent()).toHaveLength(0);
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
    ledger.decision = {
      allow: false,
      mode: 'enforce',
      reservationId: null,
      denial: { code: 'SENDING_LIMITED', window: 'hour', limit: 30, used: 30 },
    };

    const res = await request('POST', '', await createBody({ attendees: attendees(100) }));
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;

    const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
    expect(row!.attendees).toHaveLength(100);

    // The batch is asked about once per run, in the background, then skipped.
    for (let i = 0; i < 60 && ledger.calls.reserve.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(ledger.calls.reserve.length).toBeGreaterThan(0);
    for (const [subject, request] of ledger.calls.reserve as Array<[unknown, { source: string; kind: string; recipients: string[] }]>) {
      expect(subject).toMatchObject({ kind: 'workspace', workspaceId: WORKSPACE_ID, clerkOrgId: ORG_ID });
      expect(request).toMatchObject({ source: 'calendar', kind: 'new_thread' });
      expect(request.recipients).toHaveLength(100);
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(sent()).toHaveLength(0);
    expect(ledger.calls.commit).toHaveLength(0);
    warn.mockRestore();
  });

  it('an allowed batch is mailed and committed', async () => {
    const res = await request('POST', '', await createBody({ attendees: attendees(2) }));
    expect(res.status).toBe(201);

    await waitForMails(2);
    expect(sent().map((m) => m.to[0]).sort()).toEqual(['guest0@example.com', 'guest1@example.com']);
    expect(reserved().every((r) => r.recipients.length === 2)).toBe(true);
    for (let i = 0; i < 60 && ledger.calls.commit.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(ledger.calls.commit).toHaveLength(ledger.calls.reserve.length);
    expect(ledger.calls.release).toHaveLength(0);
  });

  it('a refused update still saves the new attendees', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const created = await request('POST', '', await createBody());
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    ledger.decision = {
      allow: false,
      mode: 'enforce',
      reservationId: null,
      denial: { code: 'SENDING_SUSPENDED', reason: 'staff_suspension' },
    };
    const res = await request('PATCH', `/${id}?sendNotification=true`, { attendees: attendees(3) });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
    expect(row!.attendees).toHaveLength(3);
    for (let i = 0; i < 60 && ledger.calls.reserve.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 150));
    expect(sent()).toHaveLength(0);
    warn.mockRestore();
  });
});
