/**
 * DB-backed integration tests for /api/calendars.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { calendarsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/calendars · pglite integration', () => {
  it('POST / writes a calendar with ownerId from auth context', async () => {
    const { request } = createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:create'),
        userId: 'user_calendar_owner',
        tenantDb: db,
      },
    });

    const res = await request('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Work', color: '#3b82f6' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^cal_/);

    const [row] = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Work');
    expect(row?.ownerId).toBe('user_calendar_owner');
  });

  it('POST / ignores an explicit ownerId override and stamps the caller', async () => {
    // A calendar is always owned by its creator; a body `ownerId` must not let
    // a caller create a calendar owned by someone else.
    const { request } = createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:create'),
        userId: 'user_caller',
        tenantDb: db,
      },
    });

    const res = await request('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Team', ownerId: 'user_team_lead' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.id, body.data.id))
      .limit(1);
    expect(row?.ownerId).toBe('user_caller');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:create'),
        userId: 'user_test',
        tenantDb: db,
      },
    });
    const res = await request('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  // ── Scope-isolation tests ────────────────────────────────────────────────

  it('GET / non-elevated user only sees own calendars', async () => {
    // Seed: one calendar owned by user_alice, one by user_bob
    const aliceId = 'user_scope_alice_cal';
    const bobId = 'user_scope_bob_cal';

    const { request: reqAlice } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:create'), userId: aliceId, tenantDb: db },
    });
    const { request: reqBob } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:create'), userId: bobId, tenantDb: db },
    });

    await reqAlice('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice Calendar' }),
    });
    await reqBob('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob Calendar' }),
    });

    // Alice lists — should see only her own
    const { request: listAlice } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:read'), userId: aliceId, tenantDb: db },
    });
    const listRes = await listAlice('/api/calendars');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { ownerId: string }[] };
    expect(listBody.data.every((r) => r.ownerId === aliceId)).toBe(true);
  });

  it('GET /:id non-elevated user is forbidden from another owner\'s calendar', async () => {
    // Seed a calendar owned by user_charlie
    const charlieId = 'user_scope_charlie_cal';
    const { request: seed } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:create'), userId: charlieId, tenantDb: db },
    });
    const seedRes = await seed('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Charlie Calendar' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const calId = seedBody.data.id;

    // Dave tries to read it
    const { request: reqDave } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:read'), userId: 'user_scope_dave_cal', tenantDb: db },
    });
    const res = await reqDave(`/api/calendars/${calId}`);
    expect(res.status).toBe(403);
  });

  it('GET /:id calendars:scope:all does NOT widen access to others\' calendars', async () => {
    // Calendars deliberately do not honour `scope:all` — access is
    // ownership/share-derived only, so an admin can't read a member's personal
    // calendar (see the access-model note at the top of index.ts).
    const erinId = 'user_scope_erin_cal';
    const { request: seed } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:create'), userId: erinId, tenantDb: db },
    });
    const seedRes = await seed('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Erin Calendar' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const calId = seedBody.data.id;

    // Admin with scope:all but no ownership/share is still forbidden.
    const { request: reqAdmin } = createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:read', 'calendars:scope:all'),
        userId: 'user_scope_admin_cal',
        tenantDb: db,
      },
    });
    const res = await reqAdmin(`/api/calendars/${calId}`);
    expect(res.status).toBe(403);
  });
});

// ── TASK-749: share target must be a workspace member ──────────────────────

describe('/api/calendars/:id/share · member validation', () => {
  const ownerId = 'user_share_owner';
  const memberId = 'user_share_member';

  async function seedMember(userId: string, status = 'ACTIVE') {
    await db.insert(schema.workspaceMembers).values({
      id: generateId('wm'),
      userId,
      email: `${userId}@example.com`,
      name: userId,
      status,
    });
  }

  async function seedCalendar(owner: string): Promise<string> {
    const id = generateId('cal');
    const now = new Date();
    await db.insert(schema.calendars).values({
      id,
      name: 'Shared',
      ownerId: owner,
      isDefault: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  function share(calendarId: string, sharedWithId: string, userId = ownerId) {
    const { request } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:update'), userId, tenantDb: db },
    });
    return request(`/api/calendars/${calendarId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedWithId, permission: 'view' }),
    });
  }

  beforeAll(async () => {
    await seedMember(ownerId);
    await seedMember(memberId);
    await seedMember('user_share_suspended', 'SUSPENDED');
  });

  it('rejects a share target that is not a workspace member with 422', async () => {
    const calendarId = await seedCalendar(ownerId);
    const res = await share(calendarId, 'jan@example.com');
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNPROCESSABLE_ENTITY');

    const rows = await db
      .select()
      .from(schema.calendarShares)
      .where(eq(schema.calendarShares.calendarId, calendarId));
    expect(rows).toHaveLength(0);
  });

  it('rejects a member who is not active', async () => {
    const calendarId = await seedCalendar(ownerId);
    expect((await share(calendarId, 'user_share_suspended')).status).toBe(422);
  });

  it('rejects sharing with yourself', async () => {
    const calendarId = await seedCalendar(ownerId);
    expect((await share(calendarId, ownerId)).status).toBe(422);
  });

  it('shares with an active member', async () => {
    const calendarId = await seedCalendar(ownerId);
    const res = await share(calendarId, memberId);
    expect(res.status).toBe(201);
    const [row] = await db
      .select()
      .from(schema.calendarShares)
      .where(eq(schema.calendarShares.calendarId, calendarId));
    expect(row?.sharedWithId).toBe(memberId);
  });
});

// ── TASK-745: deleting a calendar deletes its events ───────────────────────

describe('DELETE /api/calendars/:id · events, meetings and attendee mail', () => {
  const ownerId = 'user_del_owner';
  const hour = 60 * 60 * 1000;

  async function seedCalendarWithEvents() {
    const calendarId = generateId('cal');
    const now = Date.now();
    await db.insert(schema.calendars).values({
      id: calendarId,
      name: 'QA3 Calendar',
      ownerId,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const base = { type: 'meeting', calendarId, organizerId: ownerId };
    const upcoming = generateId('evt');
    const past = generateId('evt');
    const solo = generateId('evt');
    await db.insert(schema.calendarEvents).values([
      {
        ...base,
        id: upcoming,
        title: 'Upcoming with guest',
        startTime: new Date(now + 24 * hour),
        endTime: new Date(now + 25 * hour),
        attendees: [{ email: 'guest@example.com', name: 'Guest' }],
      },
      {
        ...base,
        id: past,
        title: 'Past with guest',
        startTime: new Date(now - 48 * hour),
        endTime: new Date(now - 47 * hour),
        attendees: [{ email: 'old-guest@example.com' }],
      },
      {
        ...base,
        id: solo,
        title: 'Upcoming, no guests',
        startTime: new Date(now + 2 * hour),
        endTime: new Date(now + 3 * hour),
      },
    ]);
    const meetingId = generateId('mtg');
    await db.insert(schema.meetings).values({
      id: meetingId,
      title: 'Upcoming with guest',
      organizerId: ownerId,
      joinCode: `wm-${meetingId}`,
      status: 'scheduled',
      calendarEventId: upcoming,
      attendees: [],
    });
    return { calendarId, upcoming, past, solo, meetingId };
  }

  function api(userId = ownerId) {
    return createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:read', 'calendars:delete'),
        userId,
        tenantDb: db,
      },
      env: { RESEND_API_KEY: 're_test' },
    });
  }

  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** Recipients of every Resend call made so far. */
  function resendRecipients(): string[] {
    return fetchSpy.mock.calls
      .filter(([url]) => String(url).includes('api.resend.com'))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { to: string[] }).to);
  }

  it('GET /:id/delete-impact counts every event and the upcoming ones with guests', async () => {
    const { calendarId } = await seedCalendarWithEvents();
    const res = await api().request(`/api/calendars/${calendarId}/delete-impact`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { eventCount: number; eventsWithAttendees: number } };
    expect(body.data).toEqual({ eventCount: 3, eventsWithAttendees: 1 });
  });

  it('GET /:id/delete-impact is owner only', async () => {
    const { calendarId } = await seedCalendarWithEvents();
    const res = await api('user_del_other').request(`/api/calendars/${calendarId}/delete-impact`);
    expect(res.status).toBe(403);
  });

  it('deletes the events, cancels the linked meeting and mails upcoming guests on sendNotification=true', async () => {
    const { calendarId, upcoming, past, solo, meetingId } = await seedCalendarWithEvents();
    const res = await api().request(`/api/calendars/${calendarId}?sendNotification=true`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);

    const [cal] = await db.select().from(schema.calendars).where(eq(schema.calendars.id, calendarId));
    expect(cal?.deletedAt).not.toBeNull();
    const events = await db
      .select()
      .from(schema.calendarEvents)
      .where(inArray(schema.calendarEvents.id, [upcoming, past, solo]));
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.deletedAt !== null)).toBe(true);

    const [meeting] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meetingId));
    expect(meeting?.status).toBe('cancelled');

    // Mail goes out through waitUntil; only the upcoming event's guest is mailed.
    await vi.waitFor(() => expect(resendRecipients()).toEqual(['guest@example.com']));
  });

  it('sends no mail without sendNotification but still cancels the meeting', async () => {
    const { calendarId, meetingId } = await seedCalendarWithEvents();
    const res = await api().request(`/api/calendars/${calendarId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [meeting] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meetingId));
    expect(meeting?.status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 20));
    expect(resendRecipients()).toEqual([]);
  });

  it('forbids a sharee (even with manage) from deleting', async () => {
    const { calendarId, upcoming } = await seedCalendarWithEvents();
    await db.insert(schema.calendarShares).values({
      id: generateId('csh'),
      calendarId,
      sharedWithId: 'user_del_sharee',
      permission: 'manage',
      sharedById: ownerId,
    });
    const res = await api('user_del_sharee').request(`/api/calendars/${calendarId}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
    const [event] = await db
      .select()
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, upcoming));
    expect(event?.deletedAt).toBeNull();
  });
});
