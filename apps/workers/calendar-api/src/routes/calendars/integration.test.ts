/**
 * DB-backed integration tests for /api/calendars.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { calendarsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { memoryTransport } from '@weldsuite/emails/transports/memory';
import { readSent } from '../../test/sent-mail';

const mail = vi.hoisted(() => ({ transport: null as ReturnType<typeof memoryTransport> | null }));
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: () => mail.transport }));

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
    });
  }

  beforeEach(() => {
    mail.transport = memoryTransport();
  });

  /** Recipients of every mail sent so far. */
  function mailRecipients(): string[] {
    return readSent(mail.transport).flatMap((m) => m.to);
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
    await vi.waitFor(() => expect(mailRecipients()).toEqual(['guest@example.com']));
  });

  it('renders the cancellation mail in the event timezone, not UTC (TASK-760)', async () => {
    const calendarId = generateId('cal');
    await db.insert(schema.calendars).values({
      id: calendarId,
      name: 'TZ Calendar',
      ownerId,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // 8:00-9:00 UTC is 10:00-11:00 in Amsterdam in summer (CEST, UTC+2); pin a fixed
    // far-future summer date so the offset never depends on when the test runs.
    await db.insert(schema.calendarEvents).values({
      id: generateId('evt'),
      calendarId,
      organizerId: ownerId,
      type: 'meeting',
      title: 'Zoned',
      startTime: new Date('2090-07-01T08:00:00.000Z'),
      endTime: new Date('2090-07-01T09:00:00.000Z'),
      timezone: 'Europe/Amsterdam',
      attendees: [{ email: 'tz-guest@example.com' }],
    });

    const res = await api().request(`/api/calendars/${calendarId}?sendNotification=true`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);

    await vi.waitFor(() => {
      const sent = readSent(mail.transport).find((m) => m.to.includes('tz-guest@example.com'));
      expect(sent).toBeDefined();
      // The zone is written once, at the end of the range.
      expect(sent?.html).toContain('10:00 AM – 11:00 AM GMT+2');
      expect(sent?.html).not.toContain('UTC');
    });
  });

  it('sends no mail without sendNotification but still cancels the meeting', async () => {
    const { calendarId, meetingId } = await seedCalendarWithEvents();
    const res = await api().request(`/api/calendars/${calendarId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [meeting] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, meetingId));
    expect(meeting?.status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 20));
    expect(mailRecipients()).toEqual([]);
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

// ── Update, default calendar, shares ───────────────────────────────────────

describe('/api/calendars · update, default calendar and shares', () => {
  const owner = 'user_cal_more_owner';
  const member = 'user_cal_more_member';
  const manager = 'user_cal_more_manager';
  const JSON_HEADERS = { 'Content-Type': 'application/json' };

  function api(userId: string, ...perms: string[]) {
    return createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions(...perms), userId, tenantDb: db },
    }).request;
  }

  beforeAll(async () => {
    await db.insert(schema.workspaceMembers).values(
      [owner, member, manager].map((userId) => ({
        id: generateId('wm'),
        userId,
        email: `${userId}@example.com`,
        name: userId,
        status: 'ACTIVE',
      })),
    );
  });

  async function seedCalendar(extra: Partial<typeof schema.calendars.$inferInsert> = {}): Promise<string> {
    const id = generateId('cal');
    await db.insert(schema.calendars).values({ id, name: 'Team', ownerId: owner, isDefault: false, isActive: true, ...extra });
    return id;
  }

  it('creates the default calendar once, then returns it', async () => {
    const userId = `user_cal_default_${Date.now().toString(36)}`;
    const first = await api(userId, 'calendars:create')('/api/calendars/ensure-default', { method: 'POST' });
    expect(first.status).toBe(201);
    const created = ((await first.json()) as { data: { id: string; isDefault: boolean; color: string } }).data;
    expect(created.isDefault).toBe(true);
    expect(created.color).toBe('#3b82f6');
    const second = await api(userId, 'calendars:create')('/api/calendars/ensure-default', { method: 'POST' });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { id: string } }).data.id).toBe(created.id);
    expect((await api(userId)('/api/calendars/ensure-default', { method: 'POST' })).status).toBe(403);
  });

  it('lists own calendars first, then those shared with the caller', async () => {
    const userId = `user_cal_list_${Date.now().toString(36)}`;
    await db.insert(schema.calendars).values([
      { id: generateId('cal'), name: 'Zeta', ownerId: userId, isDefault: false },
      { id: generateId('cal'), name: 'Alpha', ownerId: userId, isDefault: true },
    ]);
    const shared = await seedCalendar({ name: 'Shared to me' });
    await db.insert(schema.calendarShares).values({
      id: generateId('csh'),
      calendarId: shared,
      sharedWithId: userId,
      permission: 'edit',
      sharedById: owner,
    });
    const res = await api(userId, 'calendars:read')('/api/calendars');
    const body = (await res.json()) as { data: { name: string; isOwn: boolean; permission: string }[] };
    expect(body.data.map((c) => [c.name, c.isOwn, c.permission])).toEqual([
      ['Alpha', true, 'manage'],
      ['Zeta', true, 'manage'],
      ['Shared to me', false, 'edit'],
    ]);
    const detail = await api(userId, 'calendars:read')(`/api/calendars/${shared}`);
    expect(detail.status).toBe(200);
    expect((await api(userId, 'calendars:read')('/api/calendars/cal_missing')).status).toBe(404);
    expect((await api(userId)('/api/calendars')).status).toBe(403);
  });

  it('PATCH updates the owner\'s calendar only', async () => {
    const id = await seedCalendar();
    const patch = (userId: string, body: unknown) =>
      api(userId, 'calendars:update')(`/api/calendars/${id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    const res = await patch(owner, { name: 'Renamed', color: '#ff0000' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id, name: 'Renamed', color: '#ff0000' } });
    const [row] = await db.select().from(schema.calendars).where(eq(schema.calendars.id, id));
    expect(row?.name).toBe('Renamed');
    expect((await patch(member, { name: 'Mine now' })).status).toBe(403);
    expect((await patch(owner, { color: 'x'.repeat(21) })).status).toBe(400);
    expect((await patch(owner, { name: '' })).status).toBe(400);
    expect((await api(owner, 'calendars:update')('/api/calendars/cal_missing', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: '{}',
    })).status).toBe(404);
  });

  it('refuses to delete the default calendar or an unknown one', async () => {
    const id = await seedCalendar({ isDefault: true });
    const del = api(owner, 'calendars:delete', 'calendars:read');
    const res = await del(`/api/calendars/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await del(`/api/calendars/${id}/delete-impact`)).status).toBe(400);
    expect((await del('/api/calendars/cal_missing', { method: 'DELETE' })).status).toBe(404);
  });

  it('shares, updates a share, lists and removes shares', async () => {
    const id = await seedCalendar();
    const share = (userId: string, body: unknown) =>
      api(userId, 'calendars:update')(`/api/calendars/${id}/share`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    const created = await share(owner, { sharedWithId: manager, permission: 'manage' });
    expect(created.status).toBe(201);
    const shareId = ((await created.json()) as { data: { id: string } }).data.id;

    // A manage sharee may share on; an update of an existing share is a 200.
    const onward = await share(manager, { sharedWithId: member });
    expect(onward.status).toBe(201);
    const updated = await share(owner, { sharedWithId: member, permission: 'edit' });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { data: { permission: string } }).data.permission).toBe('edit');

    // A view/edit sharee may not; nor can a share target the owner.
    expect((await share(member, { sharedWithId: manager })).status).toBe(403);
    expect((await share(manager, { sharedWithId: owner })).status).toBe(422);
    expect((await share(owner, { sharedWithId: '  ' })).status).toBe(400);
    expect((await share(owner, { sharedWithId: member, permission: 'own' })).status).toBe(400);
    expect((await api(owner, 'calendars:update')('/api/calendars/cal_missing/share', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sharedWithId: member }),
    })).status).toBe(404);
    // Someone who can't see the calendar gets a 403, not a 404.
    expect((await share('user_cal_more_stranger', { sharedWithId: member })).status).toBe(403);

    const list = await api(owner, 'calendars:read')(`/api/calendars/${id}/shares`);
    expect(list.status).toBe(200);
    const shares = (await list.json()) as { data: { sharedWithId: string; permission: string }[] };
    expect(shares.data.map((s) => [s.sharedWithId, s.permission]).sort()).toEqual([
      [manager, 'manage'],
      [member, 'edit'],
    ]);
    expect((await api(manager, 'calendars:read')(`/api/calendars/${id}/shares`)).status).toBe(403);
    expect((await api(owner, 'calendars:read')('/api/calendars/cal_missing/shares')).status).toBe(404);

    const remove = (userId: string, path: string) =>
      api(userId, 'calendars:update')(path, { method: 'DELETE' });
    expect((await remove(manager, `/api/calendars/${id}/share/${shareId}`)).status).toBe(403);
    expect((await remove(owner, '/api/calendars/cal_missing/share/csh_x')).status).toBe(404);
    expect((await remove(owner, `/api/calendars/${id}/share/${shareId}`)).status).toBe(204);
    const after = await api(owner, 'calendars:read')(`/api/calendars/${id}/shares`);
    expect(((await after.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await api(owner)(`/api/calendars/${id}/share/${shareId}`, { method: 'DELETE' })).status).toBe(403);
  });
});
