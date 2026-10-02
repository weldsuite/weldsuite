/**
 * DB-backed integration tests for /api/meetings.
 *
 * The route now defaults `organizerId` from `c.get('userId')` when the body
 * omits it — tests no longer need to pass an explicit `organizerId`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { meetingsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/meetings · pglite integration', () => {
  it('POST / writes a meeting row with organizerId from auth context', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:create'),
        userId: 'user_mtg_creator',
        tenantDb: db,
      },
    });

    const res = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'E2E Sync' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^mtg_/);

    const [row] = await db
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, body.data.id))
      .limit(1);
    expect(row?.title).toBe('E2E Sync');
    expect(row?.organizerId).toBe('user_mtg_creator');
  });

  // TASK-688: "Create a meeting for later" produced a share link ending in
  // /null because only the start-instant path generated a joinCode.
  it('POST / (non-instant) generates a joinCode, returns it and persists it', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:create', 'meetings:read'),
        userId: 'user_mtg_later',
        tenantDb: db,
      },
    });

    const res = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Meeting',
        meetingType: 'video',
        accessType: 'anyone_with_link',
        waitingRoom: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; joinCode: string | null } };
    expect(body.data.joinCode).toMatch(/^wm-[a-z]{3}-[a-z]{3}-[a-z]{3}$/);

    const [row] = await db
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, body.data.id))
      .limit(1);
    expect(row?.joinCode).toBe(body.data.joinCode);

    // The join-code lookup used by the guest link resolves the new meeting.
    const lookup = await request(`/api/meetings/join/${body.data.joinCode}`);
    expect(lookup.status).toBe(200);
  });

  it('POST / ignores a client-supplied joinCode and gives each meeting a distinct one', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:create'),
        userId: 'user_mtg_later',
        tenantDb: db,
      },
    });
    const create = async () => {
      const res = await request('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Meeting', joinCode: 'attacker-chosen' }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { joinCode: string } }).data.joinCode;
    };
    const [a, b] = [await create(), await create()];
    expect(a).not.toBe('attacker-chosen');
    expect(a).not.toBe(b);
  });

  it('POST / accepts explicit organizerId override', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:create'),
        userId: 'user_mtg_caller',
        tenantDb: db,
      },
    });

    const res = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Delegated Meeting', organizerId: 'user_mtg_delegate' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, body.data.id))
      .limit(1);
    expect(row?.organizerId).toBe('user_mtg_delegate');
  });

  it('POST / rejects empty title', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), tenantDb: db },
    });
    const res = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
  });

  // ── Scope-isolation tests ────────────────────────────────────────────────

  it('GET / non-elevated user only sees own meetings', async () => {
    const aliceId = 'user_scope_alice_mtg';
    const bobId = 'user_scope_bob_mtg';

    const { request: reqAlice } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: aliceId, tenantDb: db },
    });
    const { request: reqBob } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: bobId, tenantDb: db },
    });

    await reqAlice('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alice Meeting' }),
    });
    await reqBob('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bob Meeting' }),
    });

    const { request: listAlice } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), userId: aliceId, tenantDb: db },
    });
    const listRes = await listAlice('/api/meetings');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { organizerId: string }[] };
    expect(listBody.data.every((r) => r.organizerId === aliceId)).toBe(true);
  });

  it('GET /:id non-elevated user gets 404 for another organizer\'s meeting', async () => {
    const charlieId = 'user_scope_charlie_mtg';
    const { request: seed } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: charlieId, tenantDb: db },
    });
    const seedRes = await seed('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Charlie Meeting' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const mtgId = seedBody.data.id;

    const { request: reqDave } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), userId: 'user_scope_dave_mtg', tenantDb: db },
    });
    const res = await reqDave(`/api/meetings/${mtgId}`);
    expect(res.status).toBe(404);
  });

  it('GET /:id elevated user (meetings:scope:all) can read any meeting', async () => {
    const erinId = 'user_scope_erin_mtg';
    const { request: seed } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: erinId, tenantDb: db },
    });
    const seedRes = await seed('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Erin Meeting' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const mtgId = seedBody.data.id;

    const { request: reqAdmin } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:read', 'meetings:scope:all'),
        userId: 'user_scope_admin_mtg',
        tenantDb: db,
      },
    });
    const res = await reqAdmin(`/api/meetings/${mtgId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; organizerId: string } };
    expect(body.data.organizerId).toBe(erinId);
  });

  it('PATCH /:id/host-controls rejects non-organizer regardless of scope', async () => {
    // Organizer creates the meeting
    const organizerId = 'user_scope_hc_organizer';
    const { request: seed } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: organizerId, tenantDb: db },
    });
    const seedRes = await seed('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Host Control Test Meeting' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const mtgId = seedBody.data.id;

    // Admin user with scope:all tries host-controls — should still get 403
    // because host-controls enforces exact organizer identity, not scope
    const { request: reqAdmin } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:read', 'meetings:scope:all'),
        userId: 'user_scope_admin_hc',
        tenantDb: db,
      },
    });
    const res = await reqAdmin(`/api/meetings/${mtgId}/host-controls`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowScreenShare: false }),
    });
    expect(res.status).toBe(403);
  });

  // ── TASK-724: create / update a scheduled meeting (calendar link) ─────────

  describe('scheduled meetings', () => {
    const organizerId = 'user_sched_org';

    function app(perms: string[]) {
      return createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions(...perms), userId: organizerId, tenantDb: db },
      });
    }

    function post(body: unknown) {
      return app(['meetings:create']).request('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function rowOf(id: string) {
      const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, id)).limit(1);
      return row;
    }

    it('POST / stores ISO schedule times as dates, normalised attendees, settings and the calendar link', async () => {
      const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const res = await post({
        title: 'Planning',
        meetingType: 'audio',
        accessType: 'anyone_with_link',
        waitingRoom: false,
        allowRecording: false,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        calendarEventId: 'cev_test_link',
        attendees: [
          { email: 'Guest@Example.com', name: 'Guest One' },
          { email: 'guest@example.com' },
          { email: 'bare@example.com' },
        ],
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string } };

      const row = await rowOf(data.id);
      expect(row?.scheduledStart).toBeInstanceOf(Date);
      expect(row?.scheduledStart?.toISOString()).toBe(start.toISOString());
      expect(row?.scheduledEnd?.toISOString()).toBe(end.toISOString());
      expect(row?.calendarEventId).toBe('cev_test_link');
      expect(row?.status).toBe('scheduled');
      expect(row?.meetingType).toBe('audio');
      expect(row?.accessType).toBe('anyone_with_link');
      expect(row?.waitingRoom).toBe(false);
      expect(row?.allowRecording).toBe(false);
      expect(row?.attendees).toEqual([
        { userId: '', email: 'guest@example.com', name: 'Guest One', status: 'pending', role: 'attendee' },
        { userId: '', email: 'bare@example.com', name: 'bare@example.com', status: 'pending', role: 'attendee' },
      ]);

      const upcoming = await app(['meetings:read']).request('/api/meetings/upcoming');
      expect(upcoming.status).toBe(200);
      const list = (await upcoming.json()) as { data: { id: string }[] };
      expect(list.data.map((m) => m.id)).toContain(data.id);
    });

    it('POST / still works without a schedule', async () => {
      const res = await post({ title: 'Instant-ish' });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string } };
      const row = await rowOf(data.id);
      expect(row?.scheduledStart).toBeNull();
      expect(row?.scheduledEnd).toBeNull();
      expect(row?.calendarEventId).toBeNull();
      expect(row?.status).toBe('scheduled');
    });

    it('POST / rejects a malformed schedule time', async () => {
      const res = await post({ title: 'Bad time', scheduledStart: 'next tuesday' });
      expect(res.status).toBe(400);
    });

    it('PATCH /:id converts schedule times to dates and null clears them', async () => {
      const created = await post({ title: 'Move me' });
      const { data } = (await created.json()) as { data: { id: string } };
      const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

      const patch = (body: unknown) =>
        app(['meetings:update']).request(`/api/meetings/${data.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      const res = await patch({ scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 1800_000).toISOString() });
      expect(res.status).toBe(200);
      const row = await rowOf(data.id);
      expect(row?.scheduledStart?.toISOString()).toBe(start.toISOString());
      expect(row?.scheduledEnd?.getTime()).toBe(start.getTime() + 1800_000);

      const cleared = await patch({ scheduledStart: null, scheduledEnd: null });
      expect(cleared.status).toBe(200);
      const after = await rowOf(data.id);
      expect(after?.scheduledStart).toBeNull();
      expect(after?.scheduledEnd).toBeNull();
    });

    it('PATCH /:id still accepts the full attendee shape', async () => {
      const created = await post({ title: 'Roster' });
      const { data } = (await created.json()) as { data: { id: string } };
      const attendee = {
        userId: 'user_x',
        email: 'x@example.com',
        name: 'X',
        status: 'accepted',
        role: 'organizer',
      };
      const res = await app(['meetings:update']).request(`/api/meetings/${data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendees: [attendee] }),
      });
      expect(res.status).toBe(200);
      expect((await rowOf(data.id))?.attendees).toEqual([attendee]);
    });
  });

  // ── TASK-717: invite external guests by email ─────────────────────────────

  describe('POST /:id/invitations', () => {
    const organizerId = 'user_invite_org';

    async function seedMeeting(extra: Record<string, unknown> = {}) {
      const { request } = createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions('meetings:create'), userId: organizerId, tenantDb: db },
      });
      const res = await request('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Invite test', accessType: 'anyone_with_link', ...extra }),
      });
      return ((await res.json()) as { data: { id: string } }).data.id;
    }

    function invite(meetingId: string, body: unknown, userId = organizerId) {
      const { request } = createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions('meetings:update'), userId, tenantDb: db },
      });
      return request(`/api/meetings/${meetingId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function attendeesOf(meetingId: string) {
      const [row] = await db
        .select({ attendees: schema.meetings.attendees })
        .from(schema.meetings)
        .where(eq(schema.meetings.id, meetingId))
        .limit(1);
      return row?.attendees ?? [];
    }

    it('adds an external email as a pending attendee linked to a Person', async () => {
      const meetingId = await seedMeeting();
      const res = await invite(meetingId, { invitees: [{ email: 'WeldHost@Gmail.com' }] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { invited: { email: string; emailSent: boolean }[]; alreadyInvited: string[] };
      };
      // No RESEND_API_KEY in tests, so nothing is sent.
      expect(body.data.invited).toEqual([
        expect.objectContaining({ email: 'weldhost@gmail.com', emailSent: false }),
      ]);

      const attendees = await attendeesOf(meetingId);
      expect(attendees).toHaveLength(1);
      expect(attendees[0]).toMatchObject({
        email: 'weldhost@gmail.com',
        role: 'attendee',
        status: 'pending',
        userId: '',
      });
      expect(attendees[0]?.personId).toMatch(/^per/);
    });

    it('links a workspace member by email and sets their user id', async () => {
      await db.insert(schema.workspaceMembers).values({
        id: 'wm_invite_member',
        userId: 'user_invite_member',
        email: 'member@acme.com',
        name: 'Member Person',
      });
      const meetingId = await seedMeeting();
      const res = await invite(meetingId, { invitees: [{ email: 'member@acme.com' }] });
      expect(res.status).toBe(200);
      const [attendee] = await attendeesOf(meetingId);
      expect(attendee).toMatchObject({
        userId: 'user_invite_member',
        workspaceMemberId: 'wm_invite_member',
        name: 'Member Person',
      });
    });

    it('does not duplicate or reset an attendee who is invited twice', async () => {
      const meetingId = await seedMeeting();
      await invite(meetingId, { invitees: [{ email: 'twice@example.com' }] });
      const res = await invite(meetingId, { invitees: [{ email: 'twice@example.com' }] });
      const body = (await res.json()) as { data: { invited: unknown[]; alreadyInvited: string[] } };
      expect(body.data.invited).toEqual([]);
      expect(body.data.alreadyInvited).toEqual(['twice@example.com']);
      expect(await attendeesOf(meetingId)).toHaveLength(1);
    });

    it('rejects an invalid email', async () => {
      const meetingId = await seedMeeting();
      const res = await invite(meetingId, { invitees: [{ email: 'not-an-email' }] });
      expect(res.status).toBe(400);
    });

    it("refuses a non-organizer who isn't on the meeting", async () => {
      const meetingId = await seedMeeting();
      const res = await invite(meetingId, { invitees: [{ email: 'x@example.com' }] }, 'user_invite_stranger');
      expect(res.status).toBe(403);
    });

    it('lets an invited member invite others (in-room Add people)', async () => {
      const meetingId = await seedMeeting();
      await invite(meetingId, { invitees: [{ email: 'member@acme.com' }] });
      const res = await invite(meetingId, { invitees: [{ email: 'friend@example.com' }] }, 'user_invite_member');
      expect(res.status).toBe(200);
      expect(await attendeesOf(meetingId)).toHaveLength(2);
    });

    it('refuses to invite to a cancelled meeting', async () => {
      const meetingId = await seedMeeting({ status: 'cancelled' });
      const res = await invite(meetingId, { invitees: [{ email: 'x@example.com' }] });
      expect(res.status).toBe(400);
    });
  });
});
