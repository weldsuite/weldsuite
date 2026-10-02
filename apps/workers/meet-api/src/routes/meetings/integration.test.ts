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

  it('POST / lets a meetings:scope:all caller create on behalf of another organizer', async () => {
    await db.insert(schema.workspaceMembers).values({
      id: 'wm_mtg_delegate',
      userId: 'user_mtg_delegate',
      email: 'delegate@example.com',
      name: 'Delegate',
    });
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:create', 'meetings:scope:all'),
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

  it('POST / rejects an on-behalf organizerId that is not a workspace member', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:create', 'meetings:scope:all'),
        userId: 'user_mtg_caller',
        tenantDb: db,
      },
    });
    const res = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Ghost organizer', organizerId: 'user_not_a_member' }),
    });
    expect(res.status).toBe(400);
    const rows = await db.select().from(schema.meetings).where(eq(schema.meetings.title, 'Ghost organizer'));
    expect(rows).toHaveLength(0);
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
      // Deduplicated by email; links are resolved server-side (a Person per external guest).
      expect(row?.attendees).toEqual([
        { userId: '', email: 'guest@example.com', name: 'Guest One', status: 'pending', role: 'attendee', personId: expect.stringMatching(/^person_/) },
        { userId: '', email: 'bare@example.com', name: expect.any(String), status: 'pending', role: 'attendee', personId: expect.stringMatching(/^person_/) },
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

    it('PATCH /:id round-trips the stored attendee shape and keeps the stored links', async () => {
      const created = await post({ title: 'Roster', attendees: [{ email: 'x@example.com', name: 'X' }] });
      const { data } = (await created.json()) as { data: { id: string } };
      const stored = (await rowOf(data.id))?.attendees ?? [];
      expect(stored).toHaveLength(1);
      expect(stored[0]?.personId).toMatch(/^person_/);

      const res = await app(['meetings:update']).request(`/api/meetings/${data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendees: [{ ...stored[0], name: 'X Renamed', status: 'accepted' }] }),
      });
      expect(res.status).toBe(200);
      expect((await rowOf(data.id))?.attendees).toEqual([{ ...stored[0], name: 'X Renamed', status: 'accepted' }]);
    });

    it('does not trust client-supplied links, ids, role or source on a new attendee', async () => {
      const created = await post({ title: 'Spoofed' });
      const { data } = (await created.json()) as { data: { id: string } };
      const victim = 'per_victim_timeline';
      const res = await app(['meetings:update']).request(`/api/meetings/${data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attendees: [
            {
              userId: 'user_admin',
              email: 'spoof@example.com',
              name: 'Spoof',
              role: 'organizer',
              source: 'walk_in',
              workspaceMemberId: 'wm_admin',
              personId: victim,
              contactId: 'con_victim',
              counterpartyId: 'party_victim',
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const [attendee] = (await rowOf(data.id))?.attendees ?? [];
      expect(attendee).toMatchObject({ email: 'spoof@example.com', userId: '', role: 'attendee' });
      expect(attendee?.personId).toMatch(/^person_/);
      expect(attendee?.personId).not.toBe(victim);
      expect(attendee?.workspaceMemberId).toBeUndefined();
      expect(attendee?.contactId).toBeUndefined();
      expect(attendee?.counterpartyId).toBeUndefined();
      expect(attendee?.source).toBeUndefined();
    });

    it('cannot promote an existing attendee to organizer on PATCH', async () => {
      const created = await post({ title: 'Promote', attendees: [{ email: 'promote@example.com' }] });
      const { data } = (await created.json()) as { data: { id: string } };
      const [stored] = (await rowOf(data.id))?.attendees ?? [];
      await app(['meetings:update']).request(`/api/meetings/${data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendees: [{ email: 'promote@example.com', role: 'organizer', personId: 'per_victim_timeline' }] }),
      });
      const [after] = (await rowOf(data.id))?.attendees ?? [];
      expect(after).toMatchObject({ role: 'attendee', personId: stored?.personId });
    });

    it('links an attendee that is a workspace member to the member, with their user id', async () => {
      await db.insert(schema.workspaceMembers).values({
        id: 'wm_sched_colleague',
        userId: 'user_sched_colleague',
        email: 'Colleague@Example.com',
        name: 'Colleague',
      });
      const created = await post({ title: 'With colleague', attendees: [{ email: 'colleague@example.com', userId: 'user_someone_else' }] });
      const { data } = (await created.json()) as { data: { id: string } };
      const [attendee] = (await rowOf(data.id))?.attendees ?? [];
      expect(attendee).toMatchObject({
        email: 'colleague@example.com',
        userId: 'user_sched_colleague',
        workspaceMemberId: 'wm_sched_colleague',
        role: 'attendee',
      });
      expect(attendee?.personId).toBeUndefined();
    });
  });

  // ── TASK-717: invite external guests by email ─────────────────────────────

  describe('POST /:id/invitations', () => {
    const organizerId = 'user_invite_org';

    /** `status` is not writable through the API, so it is set on the row directly. */
    async function seedMeeting({ status, ...extra }: Record<string, unknown> & { status?: string } = {}) {
      const { request } = createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions('meetings:create'), userId: organizerId, tenantDb: db },
      });
      const res = await request('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Invite test', accessType: 'anyone_with_link', ...extra }),
      });
      const id = ((await res.json()) as { data: { id: string } }).data.id;
      if (status) await db.update(schema.meetings).set({ status }).where(eq(schema.meetings.id, id));
      return id;
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

  // ── TASK-738: only the allow-listed fields are writable ───────────────────

  describe('mass assignment', () => {
    const callerId = 'user_mass_caller';

    function app(perms: string[], userId = callerId) {
      return createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions(...perms), userId, tenantDb: db },
      });
    }

    function send(method: 'POST' | 'PATCH', path: string, perms: string[], body: unknown, userId = callerId) {
      return app(perms, userId).request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function rowOf(id: string) {
      const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, id)).limit(1);
      return row;
    }

    it('POST / ignores id, status, deletedAt, activeSessionId, joinCode and the other server-owned keys', async () => {
      const res = await send('POST', '/api/meetings', ['meetings:create'], {
        title: 'Mass assignment',
        id: 'mtg_attacker',
        status: 'completed',
        deletedAt: '2020-01-01T00:00:00.000Z',
        activeSessionId: 'msess_attacker',
        joinCode: 'attacker-code',
        chatChannelId: 'chan_attacker',
        parentMeetingId: 'mtg_parent',
        hostManagement: false,
        allowScreenShare: false,
        createdAt: '2001-01-01T00:00:00.000Z',
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string; joinCode: string } };
      expect(data.id).toMatch(/^mtg_/);
      expect(data.id).not.toBe('mtg_attacker');
      expect(await rowOf('mtg_attacker')).toBeUndefined();

      const row = await rowOf(data.id);
      expect(row?.status).toBe('scheduled');
      expect(row?.deletedAt).toBeNull();
      expect(row?.activeSessionId).toBeNull();
      expect(row?.joinCode).toBe(data.joinCode);
      expect(row?.joinCode).not.toBe('attacker-code');
      expect(row?.chatChannelId).toBeNull();
      expect(row?.parentMeetingId).toBeNull();
      expect(row?.hostManagement).toBe(true);
      expect(row?.allowScreenShare).toBe(true);
      expect(row?.createdAt.getFullYear()).toBeGreaterThan(2020);
    });

    it('POST / ignores an organizerId from a caller without meetings:scope:all', async () => {
      const res = await send('POST', '/api/meetings', ['meetings:create'], {
        title: 'Not delegated',
        organizerId: 'user_someone_else',
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string } };
      expect((await rowOf(data.id))?.organizerId).toBe(callerId);
    });

    it('POST / accepts and ignores createCalendarEvent (sent by the mobile app)', async () => {
      const res = await send('POST', '/api/meetings', ['meetings:create'], {
        title: 'Mobile',
        createCalendarEvent: true,
        attendees: [],
        isRecurring: false,
      });
      expect(res.status).toBe(201);
    });

    it('PATCH /:id ignores organizerId, status, activeSessionId, joinCode, deletedAt and host controls', async () => {
      const created = await send('POST', '/api/meetings', ['meetings:create'], { title: 'Patch me' });
      const { data } = (await created.json()) as { data: { id: string; joinCode: string } };

      const res = await send('PATCH', `/api/meetings/${data.id}`, ['meetings:update'], {
        title: 'Patched',
        organizerId: 'user_attacker',
        status: 'cancelled',
        activeSessionId: 'msess_attacker',
        joinCode: 'attacker-code',
        deletedAt: '2020-01-01T00:00:00.000Z',
        hostManagement: false,
        id: 'mtg_other',
      });
      expect(res.status).toBe(200);

      const row = await rowOf(data.id);
      expect(row?.title).toBe('Patched');
      expect(row?.organizerId).toBe(callerId);
      expect(row?.status).toBe('scheduled');
      expect(row?.activeSessionId).toBeNull();
      expect(row?.joinCode).toBe(data.joinCode);
      expect(row?.deletedAt).toBeNull();
      expect(row?.hostManagement).toBe(true);
      expect(row?.id).toBe(data.id);
    });

    it('PATCH /:id updates every allow-listed field, including a nullable maxParticipants', async () => {
      const created = await send('POST', '/api/meetings', ['meetings:create'], { title: 'All fields', maxParticipants: 10 });
      const { data } = (await created.json()) as { data: { id: string } };
      const start = new Date(Date.now() + 86_400_000);
      const res = await send('PATCH', `/api/meetings/${data.id}`, ['meetings:update'], {
        description: 'Agenda',
        meetingType: 'audio',
        accessType: 'invited_only',
        waitingRoom: false,
        allowRecording: false,
        maxParticipants: null,
        scheduledStart: start.toISOString(),
        calendarEventId: 'cev_1',
        isRecurring: true,
        recurrenceRule: 'FREQ=WEEKLY',
        tags: ['a', 'b'],
      });
      expect(res.status).toBe(200);
      const row = await rowOf(data.id);
      expect(row).toMatchObject({
        description: 'Agenda',
        meetingType: 'audio',
        accessType: 'invited_only',
        waitingRoom: false,
        allowRecording: false,
        maxParticipants: null,
        calendarEventId: 'cev_1',
        isRecurring: true,
        recurrenceRule: 'FREQ=WEEKLY',
        tags: ['a', 'b'],
      });
      expect(row?.scheduledStart?.toISOString()).toBe(start.toISOString());
    });

    it('PATCH /:id validates attendees and strips keys outside the attendee shape', async () => {
      const created = await send('POST', '/api/meetings', ['meetings:create'], { title: 'Roster' });
      const { data } = (await created.json()) as { data: { id: string } };

      const bad = await send('PATCH', `/api/meetings/${data.id}`, ['meetings:update'], {
        attendees: [{ email: 'not-an-email' }],
      });
      expect(bad.status).toBe(400);
      const notAList = await send('PATCH', `/api/meetings/${data.id}`, ['meetings:update'], {
        attendees: 'everyone',
      });
      expect(notAList.status).toBe(400);

      const ok = await send('PATCH', `/api/meetings/${data.id}`, ['meetings:update'], {
        attendees: [
          {
            userId: 'user_a',
            email: 'a@example.com',
            name: 'A',
            status: 'accepted',
            role: 'attendee',
            source: 'walk_in',
            workspaceMemberId: 'wm_a',
            personId: 'per_a',
            contactId: null,
            isAdmin: true,
          },
        ],
      });
      expect(ok.status).toBe(200);
      // Display fields are kept; keys outside the attendee shape and every
      // client-supplied link / identity are dropped (see the spoofing test above).
      const [attendee] = (await rowOf(data.id))?.attendees ?? [];
      expect(attendee).toEqual({
        userId: '',
        email: 'a@example.com',
        name: 'A',
        status: 'accepted',
        role: 'attendee',
        personId: expect.stringMatching(/^person_/),
      });
      expect(attendee).not.toHaveProperty('isAdmin');
    });
  });

  // ── TASK-729: organizer attendee, recording, list shape ───────────────────

  describe('organizer attendee on create', () => {
    const organizerId = 'user_org_attendee';

    beforeAll(async () => {
      await db.insert(schema.workspaceMembers).values({
        id: 'wm_org_attendee',
        userId: organizerId,
        email: 'Organizer@Example.com',
        name: 'Olivia Organizer',
        picture: 'https://cdn.example.com/olivia.png',
      });
    });

    function create(body: unknown) {
      return createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions('meetings:create'), userId: organizerId, tenantDb: db },
      }).request('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function attendeesOf(id: string) {
      const [row] = await db
        .select({ attendees: schema.meetings.attendees })
        .from(schema.meetings)
        .where(eq(schema.meetings.id, id))
        .limit(1);
      return row?.attendees ?? [];
    }

    it('puts the organizer first, resolved from workspace_members', async () => {
      const res = await create({ title: 'With guests', attendees: [{ email: 'guest@example.com', name: 'Guest' }] });
      const { data } = (await res.json()) as { data: { id: string } };
      const attendees = await attendeesOf(data.id);
      expect(attendees).toHaveLength(2);
      expect(attendees[0]).toEqual({
        userId: organizerId,
        email: 'organizer@example.com',
        name: 'Olivia Organizer',
        avatar: 'https://cdn.example.com/olivia.png',
        status: 'accepted',
        role: 'organizer',
        workspaceMemberId: 'wm_org_attendee',
      });
      expect(attendees[1]).toMatchObject({ email: 'guest@example.com', role: 'attendee' });
    });

    it('adds the organizer to a meeting created without attendees', async () => {
      const res = await create({ title: 'Solo' });
      const { data } = (await res.json()) as { data: { id: string } };
      expect(await attendeesOf(data.id)).toEqual([expect.objectContaining({ userId: organizerId, role: 'organizer' })]);
    });

    it('does not duplicate an organizer that is already on the list', async () => {
      const res = await create({
        title: 'Already there',
        attendees: [{ userId: organizerId, email: 'organizer@example.com', name: 'Olivia', role: 'organizer', status: 'accepted' }],
      });
      const { data } = (await res.json()) as { data: { id: string } };
      expect(await attendeesOf(data.id)).toHaveLength(1);
    });
  });

  describe('GET /:id/recording', () => {
    const organizerId = 'user_rec_org';

    async function seedMeeting() {
      const { request } = createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions('meetings:create'), userId: organizerId, tenantDb: db },
      });
      const res = await request('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Never recorded' }),
      });
      return ((await res.json()) as { data: { id: string } }).data.id;
    }

    function get(meetingId: string, userId = organizerId) {
      return createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions('meetings:read'), userId, tenantDb: db },
      }).request(`/api/meetings/${meetingId}/recording`);
    }

    it('answers 200 with null data when the meeting was never recorded', async () => {
      const id = await seedMeeting();
      const res = await get(id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: null });
    });

    it('still answers 404 for an unknown meeting and 403 without access', async () => {
      expect((await get('mtg_does_not_exist')).status).toBe(404);
      const id = await seedMeeting();
      expect((await get(id, 'user_rec_stranger')).status).toBe(403);
    });
  });

  describe('GET / list: organizer, include=lastSession and views', () => {
    const organizerId = 'user_list_org';
    const hour = 3_600_000;
    const ids = {
      future: 'mtg_list_future',
      pastScheduled: 'mtg_list_past',
      later: 'mtg_list_later',
      running: 'mtg_list_running',
      cancelled: 'mtg_list_cancelled',
      completed: 'mtg_list_completed',
      ranBefore: 'mtg_list_ran',
      unknownOrganizer: 'mtg_list_unknown_org',
    };

    type Item = {
      id: string;
      organizerId: string;
      organizer: { userId: string; name: string; avatar: string | null } | null;
      lastSession?: {
        id: string;
        status: string;
        startedAt: string | null;
        endedAt: string | null;
        duration: number | null;
        recordingStatus: string | null;
        participants: Array<Record<string, unknown>>;
      } | null;
    };

    beforeAll(async () => {
      await db.insert(schema.workspaceMembers).values({
        id: 'wm_list_org',
        userId: organizerId,
        email: 'list-org@example.com',
        name: 'Lena Lister',
        picture: 'https://cdn.example.com/lena.png',
      });
      const now = Date.now();
      const base = { organizerId, title: 'List meeting' };
      await db.insert(schema.meetings).values([
        { ...base, id: ids.future, status: 'scheduled', scheduledStart: new Date(now + 48 * hour), scheduledEnd: new Date(now + 49 * hour) },
        { ...base, id: ids.pastScheduled, status: 'scheduled', scheduledStart: new Date(now - 5 * hour), scheduledEnd: new Date(now - 4 * hour) },
        { ...base, id: ids.later, status: 'scheduled' },
        { ...base, id: ids.running, status: 'in_progress', scheduledStart: new Date(now - 5 * hour), scheduledEnd: new Date(now - 4 * hour) },
        { ...base, id: ids.cancelled, status: 'cancelled', scheduledStart: new Date(now + 48 * hour) },
        { ...base, id: ids.completed, status: 'completed', scheduledStart: new Date(now - 48 * hour), scheduledEnd: new Date(now - 47 * hour) },
        { ...base, id: ids.ranBefore, status: 'scheduled' },
        { ...base, id: ids.unknownOrganizer, organizerId: 'user_list_no_member', status: 'scheduled' },
      ]);

      const older = new Date(now - 3 * hour);
      const newer = new Date(now - 2 * hour);
      const participant = (userId: string, extra: Record<string, unknown> = {}) => ({
        userId,
        userName: `Name ${userId}`,
        userAvatar: `https://cdn.example.com/${userId}.png`,
        joinedAt: newer.toISOString(),
        leftAt: new Date(newer.getTime() + 30 * 60_000).toISOString(),
        cfSessionId: `cf_${userId}`,
        hasAudio: false,
        hasVideo: false,
        hasScreenShare: false,
        ...extra,
      });
      await db.insert(schema.meetingSessions).values([
        {
          id: 'msess_list_old',
          meetingId: ids.ranBefore,
          status: 'ended',
          startedBy: organizerId,
          startedByName: 'Lena Lister',
          participants: [participant('user_old_only')],
          startedAt: older,
          endedAt: new Date(older.getTime() + 600_000),
          duration: 600,
          createdAt: older,
          updatedAt: older,
        },
        {
          id: 'msess_list_new',
          meetingId: ids.ranBefore,
          status: 'ended',
          startedBy: organizerId,
          startedByName: 'Lena Lister',
          participants: [
            participant('user_new_rejoin', { firstJoinedAt: older.toISOString(), priorSeconds: 120, stints: 2 }),
            participant('user_new_plain'),
          ],
          startedAt: newer,
          endedAt: new Date(newer.getTime() + 1_800_000),
          duration: 1800,
          recordingStatus: 'ready',
          createdAt: newer,
          updatedAt: newer,
        },
      ]);
    });

    async function list(query = '', userId = organizerId) {
      const res = await createTestApp('/api/meetings', meetingsRoutes, {
        context: { permissions: permissions('meetings:read'), userId, tenantDb: db },
      }).request(`/api/meetings${query}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: Item[] }).data;
    }

    it('adds the organizer (member name and avatar) to every item', async () => {
      const items = await list();
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.organizer).toEqual({
          userId: organizerId,
          name: 'Lena Lister',
          avatar: 'https://cdn.example.com/lena.png',
        });
        expect(item).not.toHaveProperty('lastSession');
      }
    });

    it('gives organizer null when the organizer is no workspace member', async () => {
      const items = await list('', 'user_list_no_member');
      expect(items.map((i) => i.id)).toEqual([ids.unknownOrganizer]);
      expect(items[0].organizer).toBeNull();
    });

    it('include=lastSession returns the newest session with a trimmed participant list, null when none', async () => {
      const items = await list('?include=lastSession&limit=100');
      const byId = new Map(items.map((i) => [i.id, i]));

      expect(byId.get(ids.future)?.lastSession).toBeNull();

      const last = byId.get(ids.ranBefore)?.lastSession;
      expect(last).toMatchObject({
        id: 'msess_list_new',
        status: 'ended',
        duration: 1800,
        recordingStatus: 'ready',
      });
      expect(typeof last?.startedAt).toBe('string');
      expect(typeof last?.endedAt).toBe('string');
      expect(last?.participants).toHaveLength(2);
      const rejoin = last?.participants.find((p) => p.userId === 'user_new_rejoin');
      expect(rejoin).toMatchObject({
        userName: 'Name user_new_rejoin',
        userAvatar: 'https://cdn.example.com/user_new_rejoin.png',
        firstJoinedAt: expect.any(String),
        priorSeconds: 120,
        stints: 2,
      });
      expect(rejoin).not.toHaveProperty('cfSessionId');
    });

    it('view=upcoming keeps running, future and unscheduled meetings, drops past, cancelled and completed ones', async () => {
      const got = new Set((await list('?view=upcoming&limit=100')).map((i) => i.id));
      expect(got.has(ids.future)).toBe(true);
      expect(got.has(ids.later)).toBe(true);
      expect(got.has(ids.running)).toBe(true);
      expect(got.has(ids.ranBefore)).toBe(true);
      expect(got.has(ids.pastScheduled)).toBe(false);
      expect(got.has(ids.cancelled)).toBe(false);
      expect(got.has(ids.completed)).toBe(false);
    });

    it('view=history keeps finished meetings and any meeting that has an ended session', async () => {
      const got = new Set((await list('?view=history&limit=100')).map((i) => i.id));
      expect(got.has(ids.completed)).toBe(true);
      expect(got.has(ids.cancelled)).toBe(true);
      expect(got.has(ids.ranBefore)).toBe(true);
      expect(got.has(ids.future)).toBe(false);
      expect(got.has(ids.later)).toBe(false);
      expect(got.has(ids.running)).toBe(false);
    });

    it('still filters by status next to a view, and ignores an unknown view', async () => {
      const cancelledOnly = await list('?view=history&status=cancelled&limit=100');
      expect(cancelledOnly.every((i) => i.id === ids.cancelled)).toBe(true);
      expect((await list('?view=nonsense&limit=100')).length).toBeGreaterThanOrEqual(7);
    });
  });
});
