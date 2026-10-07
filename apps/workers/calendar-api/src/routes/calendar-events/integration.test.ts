/**
 * DB-backed integration tests for /api/calendar-events.
 *
 * The Zod schema uses camelCase aliases (startsAt/endsAt) and the route spreads
 * raw JSON into the DB insert. Drizzle's PgTimestamp mapper requires Date objects,
 * not ISO strings, so scope-isolation tests seed rows directly into the DB rather
 * than going through the POST route.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { calendarEventsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { eq } from 'drizzle-orm';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

/**
 * Seed a calendar event row directly, bypassing the route. Events are reachable
 * through the calendars the caller can access, so the event is placed in a fresh
 * calendar OWNED by `organizerId` — otherwise even the organizer couldn't see it.
 */
async function seedEvent(ownDb: Database, organizerId: string, title: string): Promise<string> {
  const id = generateId('evt');
  const calendarId = generateId('cal');
  const now = new Date();
  await ownDb.insert(schema.calendars).values({
    id: calendarId,
    name: `${organizerId} calendar`,
    ownerId: organizerId,
    isDefault: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  await ownDb.insert(schema.calendarEvents).values({
    id,
    title,
    type: 'meeting',
    startTime: now,
    endTime: new Date(now.getTime() + 30 * 60 * 1000),
    calendarId,
    organizerId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('/api/calendar-events · pglite integration', () => {
  it('POST / rejects empty title', async () => {
    const { request } = createTestApp('/api/calendar-events', calendarEventsRoutes, {
      context: { permissions: permissions('events:create'), userId: 'user_evt_test', tenantDb: db },
    });
    const res = await request('/api/calendar-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal_test_fixture',
        title: '',
        startsAt: new Date().toISOString(),
        endsAt: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(400);
  });

  // ── Scope-isolation tests ────────────────────────────────────────────────

  it('GET / non-elevated user only sees own events', async () => {
    const aliceId = 'user_scope_alice_evt';
    const bobId = 'user_scope_bob_evt';

    await seedEvent(db, aliceId, 'Alice Event');
    await seedEvent(db, bobId, 'Bob Event');

    const { request: listAlice } = createTestApp('/api/calendar-events', calendarEventsRoutes, {
      context: { permissions: permissions('events:read'), userId: aliceId, tenantDb: db },
    });
    const listRes = await listAlice('/api/calendar-events');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { organizerId: string }[] };
    expect(listBody.data.every((r) => r.organizerId === aliceId)).toBe(true);
    expect(listBody.data.length).toBeGreaterThan(0);
  });

  it('GET /:id non-elevated user gets 404 for another organizer\'s event', async () => {
    const charlieId = 'user_scope_charlie_evt';
    const evtId = await seedEvent(db, charlieId, 'Charlie Event');

    const { request: reqDave } = createTestApp('/api/calendar-events', calendarEventsRoutes, {
      context: { permissions: permissions('events:read'), userId: 'user_scope_dave_evt', tenantDb: db },
    });
    const res = await reqDave(`/api/calendar-events/${evtId}`);
    expect(res.status).toBe(404);
  });

  it('GET /:id events:scope:all does NOT widen access to others\' events', async () => {
    // Events are share-derived; `events:scope:all` is intentionally not consulted
    // (see the access-model note in index.ts). An admin without calendar access
    // gets a 404, not the event.
    const erinId = 'user_scope_erin_evt';
    const evtId = await seedEvent(db, erinId, 'Erin Event');

    const { request: reqAdmin } = createTestApp('/api/calendar-events', calendarEventsRoutes, {
      context: {
        permissions: permissions('events:read', 'events:scope:all'),
        userId: 'user_scope_admin_evt',
        tenantDb: db,
      },
    });
    const res = await reqAdmin(`/api/calendar-events/${evtId}`);
    expect(res.status).toBe(404);
  });

  // ── TASK-724: WeldMeet meeting <-> calendar event sync ───────────────────

  describe('linked WeldMeet meeting', () => {
    const JOIN_PREFIX = 'https://meet.weldsuite.org/ws_test/';

    let seq = 0;
    const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

    async function seedCalendar(ownerId: string): Promise<string> {
      const id = generateId('cal');
      const now = new Date();
      await db.insert(schema.calendars).values({
        id,
        name: `${ownerId} calendar`,
        ownerId,
        isDefault: false,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    }

    async function seedMeeting(
      organizerId: string,
      extra: Partial<typeof schema.meetings.$inferInsert> = {},
    ) {
      const id = generateId('mtg');
      const joinCode = `wm-${next()}`;
      await db.insert(schema.meetings).values({
        id,
        title: 'Planning',
        organizerId,
        joinCode,
        status: 'scheduled',
        scheduledStart: new Date('2030-01-01T10:00:00Z'),
        scheduledEnd: new Date('2030-01-01T11:00:00Z'),
        attendees: [],
        ...extra,
      });
      return { id, joinCode, url: `${JOIN_PREFIX}${joinCode}` };
    }

    async function meetingRow(id: string) {
      const [row] = await db.select().from(schema.meetings).where(eq(schema.meetings.id, id)).limit(1);
      return row!;
    }

    function api(userId: string) {
      return createTestApp('/api/calendar-events', calendarEventsRoutes, {
        context: {
          permissions: permissions('events:read', 'events:create', 'events:update', 'events:delete'),
          userId,
          tenantDb: db,
        },
      }).request;
    }

    async function send(userId: string, method: string, path: string, body?: unknown) {
      return api(userId)(`/api/calendar-events${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    /** Create an event through the route, linked to `meeting`. */
    async function createLinkedEvent(
      userId: string,
      meeting: { id: string; url: string },
      extra: Record<string, unknown> = {},
    ) {
      const calendarId = await seedCalendar(userId);
      const res = await send(userId, 'POST', '', {
        calendarId,
        title: 'Planning',
        startTime: '2030-01-01T10:00:00.000Z',
        endTime: '2030-01-01T11:00:00.000Z',
        isVirtual: true,
        meetingUrl: meeting.url,
        weldMeetingId: meeting.id,
        ...extra,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; weldMeetingLinked?: boolean } };
      return { eventId: body.data.id, calendarId, body: body.data };
    }

    it('POST / with weldMeetingId links the organizer\'s meeting and does not store the id on the event', async () => {
      const userId = `user_link_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId, body } = await createLinkedEvent(userId, meeting);

      expect(body.weldMeetingLinked).toBe(true);
      expect((await meetingRow(meeting.id)).calendarEventId).toBe(eventId);
      const [event] = await db
        .select()
        .from(schema.calendarEvents)
        .where(eq(schema.calendarEvents.id, eventId));
      expect(event).not.toHaveProperty('weldMeetingId');
      expect(event?.meetingUrl).toBe(meeting.url);
    });

    it('POST / does not link someone else\'s meeting but still creates the event', async () => {
      const owner = `user_owner_${next()}`;
      const meeting = await seedMeeting(owner);
      const { eventId, body } = await createLinkedEvent(`user_other_${next()}`, meeting);

      expect(body.weldMeetingLinked).toBe(false);
      expect((await meetingRow(meeting.id)).calendarEventId).toBeNull();
      const [event] = await db
        .select()
        .from(schema.calendarEvents)
        .where(eq(schema.calendarEvents.id, eventId));
      expect(event).toBeDefined();
    });

    it('POST / without weldMeetingId has no weldMeetingLinked in the response', async () => {
      const userId = `user_plain_${next()}`;
      const calendarId = await seedCalendar(userId);
      const res = await send(userId, 'POST', '', {
        calendarId,
        title: 'Plain',
        startTime: '2030-01-01T10:00:00.000Z',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).not.toHaveProperty('weldMeetingLinked');
    });

    it('PATCH /:id with weldMeetingId attaches a meeting to an existing event and syncs it', async () => {
      const userId = `user_attach_${next()}`;
      const calendarId = await seedCalendar(userId);
      const created = await send(userId, 'POST', '', {
        calendarId,
        title: 'Existing',
        startTime: '2030-02-01T09:00:00.000Z',
        endTime: '2030-02-01T09:30:00.000Z',
      });
      const eventId = ((await created.json()) as { data: { id: string } }).data.id;
      const meeting = await seedMeeting(userId);

      const res = await send(userId, 'PATCH', `/${eventId}`, {
        weldMeetingId: meeting.id,
        isVirtual: true,
        meetingUrl: meeting.url,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { weldMeetingLinked: boolean } }).data.weldMeetingLinked).toBe(true);

      const row = await meetingRow(meeting.id);
      expect(row.calendarEventId).toBe(eventId);
      // The event's title and time win once the two are linked.
      expect(row.title).toBe('Existing');
      expect(row.scheduledStart?.toISOString()).toBe('2030-02-01T09:00:00.000Z');
      expect(row.scheduledEnd?.toISOString()).toBe('2030-02-01T09:30:00.000Z');
    });

    it('PATCH /:id syncs title, time and attendees to the linked meeting', async () => {
      const userId = `user_sync_${next()}`;
      const walkIn = {
        userId: '',
        email: 'walkin@example.com',
        name: 'Walk In',
        status: 'pending' as const,
        role: 'attendee' as const,
        source: 'walk_in' as const,
      };
      const invitedViaMeet = {
        userId: 'user_meet_invited',
        email: 'meetinvited@example.com',
        name: 'Meet Invited',
        status: 'accepted' as const,
        role: 'attendee' as const,
      };
      const organizer = {
        userId,
        email: 'host@acme.com',
        name: 'Host',
        status: 'accepted' as const,
        role: 'organizer' as const,
      };
      const evtAttendee = {
        userId: 'user_evt_a',
        email: 'a@example.com',
        name: 'A',
        status: 'accepted' as const,
        role: 'attendee' as const,
      };
      const meeting = await seedMeeting(userId, {
        attendees: [organizer, evtAttendee, walkIn, invitedViaMeet],
      });
      const { eventId } = await createLinkedEvent(userId, meeting, {
        attendees: [{ email: 'a@example.com' }],
      });

      const res = await send(userId, 'PATCH', `/${eventId}`, {
        title: 'Renamed',
        startTime: '2030-01-03T14:00:00.000Z',
        endTime: '2030-01-03T15:00:00.000Z',
        // a removed, b and c added
        attendees: [{ email: 'b@example.com' }, { email: 'C@Example.com', name: 'Cee' }],
      });
      expect(res.status).toBe(200);

      const row = await meetingRow(meeting.id);
      expect(row.title).toBe('Renamed');
      expect(row.scheduledStart?.toISOString()).toBe('2030-01-03T14:00:00.000Z');
      expect(row.scheduledEnd?.toISOString()).toBe('2030-01-03T15:00:00.000Z');
      expect(row.status).toBe('scheduled');
      // a (removed from the event) is gone; organizer, walk-in and the meet-api
      // invitee survive; b and c are appended.
      expect(row.attendees).toEqual([
        organizer,
        walkIn,
        invitedViaMeet,
        { userId: '', email: 'b@example.com', name: 'b@example.com', status: 'pending', role: 'attendee' },
        { userId: '', email: 'c@example.com', name: 'Cee', status: 'pending', role: 'attendee' },
      ]);
    });

    it('PATCH /:id that changes nothing relevant leaves the meeting row untouched', async () => {
      const userId = `user_noop_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);
      const before = await meetingRow(meeting.id);

      const res = await send(userId, 'PATCH', `/${eventId}`, { color: '#ff0000' });
      expect(res.status).toBe(200);
      const after = await meetingRow(meeting.id);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it('PATCH /:id with meetingUrl "" clears the column and cancels the meeting', async () => {
      const userId = `user_rmurl_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      const res = await send(userId, 'PATCH', `/${eventId}`, { meetingUrl: '', isVirtual: false });
      expect(res.status).toBe(200);

      const [event] = await db
        .select()
        .from(schema.calendarEvents)
        .where(eq(schema.calendarEvents.id, eventId));
      expect(event?.meetingUrl).toBeNull();
      expect((await meetingRow(meeting.id)).status).toBe('cancelled');
    });

    it('PATCH /:id replacing the join link with another URL cancels the meeting', async () => {
      const userId = `user_swapurl_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      await send(userId, 'PATCH', `/${eventId}`, { meetingUrl: 'https://meet.google.com/abc-defg-hij' });
      expect((await meetingRow(meeting.id)).status).toBe('cancelled');
    });

    it('PATCH /:id setting status cancelled cancels the meeting', async () => {
      const userId = `user_stat_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      await send(userId, 'PATCH', `/${eventId}`, { status: 'cancelled' });
      expect((await meetingRow(meeting.id)).status).toBe('cancelled');
    });

    // ── TASK-935: a cancelled event that is on again ───────────────────────

    it('PATCH /:id taking the status off cancelled restores the meeting', async () => {
      const userId = `user_restore_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      await send(userId, 'PATCH', `/${eventId}`, { status: 'cancelled' });
      expect((await meetingRow(meeting.id)).status).toBe('cancelled');

      const res = await send(userId, 'PATCH', `/${eventId}`, { status: 'confirmed' });
      expect(res.status).toBe(200);
      expect((await meetingRow(meeting.id)).status).toBe('scheduled');
    });

    it('a restored meeting picks up the edits made while the event was cancelled', async () => {
      const userId = `user_restore_edit_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      await send(userId, 'PATCH', `/${eventId}`, { status: 'cancelled' });
      await send(userId, 'PATCH', `/${eventId}`, {
        title: 'Renamed while off',
        startTime: '2030-01-04T14:00:00.000Z',
        endTime: '2030-01-04T15:00:00.000Z',
      });
      // Still cancelled: an edit alone does not bring the meeting back.
      expect((await meetingRow(meeting.id)).status).toBe('cancelled');

      await send(userId, 'PATCH', `/${eventId}`, { status: 'tentative' });
      const row = await meetingRow(meeting.id);
      expect(row.status).toBe('scheduled');
      expect(row.title).toBe('Renamed while off');
      expect(row.scheduledStart?.toISOString()).toBe('2030-01-04T14:00:00.000Z');
      expect(row.scheduledEnd?.toISOString()).toBe('2030-01-04T15:00:00.000Z');
    });

    it('does not restore a meeting whose link the event no longer carries', async () => {
      const userId = `user_restore_unlinked_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      // Removing the link cancels the meeting; that is not undone by a later
      // cancel + un-cancel of the event.
      await send(userId, 'PATCH', `/${eventId}`, { meetingUrl: '', isVirtual: false });
      await send(userId, 'PATCH', `/${eventId}`, { status: 'cancelled' });
      await send(userId, 'PATCH', `/${eventId}`, { status: 'confirmed' });
      expect((await meetingRow(meeting.id)).status).toBe('cancelled');
    });

    it('does not bring back a meeting that already ran', async () => {
      const userId = `user_restore_done_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);
      await db
        .update(schema.meetings)
        .set({ status: 'completed' })
        .where(eq(schema.meetings.id, meeting.id));

      await send(userId, 'PATCH', `/${eventId}`, { status: 'cancelled' });
      await send(userId, 'PATCH', `/${eventId}`, { status: 'confirmed' });
      expect((await meetingRow(meeting.id)).status).toBe('completed');
    });

    it('DELETE /:id cancels the linked meeting', async () => {
      const userId = `user_del_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      const res = await send(userId, 'DELETE', `/${eventId}`);
      expect(res.status).toBe(204);
      const row = await meetingRow(meeting.id);
      expect(row.status).toBe('cancelled');
      expect(row.deletedAt).toBeNull();
    });

    it('PATCH /:id/cancel cancels the linked meeting', async () => {
      const userId = `user_cancel_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      const res = await send(userId, 'PATCH', `/${eventId}/cancel`);
      expect(res.status).toBe(200);
      expect((await meetingRow(meeting.id)).status).toBe('cancelled');
    });

    it('PATCH /:id/reschedule moves the linked meeting', async () => {
      const userId = `user_resched_${next()}`;
      const meeting = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, meeting);

      const res = await send(userId, 'PATCH', `/${eventId}/reschedule`, {
        startTime: '2030-03-05T08:00:00.000Z',
        endTime: '2030-03-05T08:45:00.000Z',
      });
      expect(res.status).toBe(200);
      const row = await meetingRow(meeting.id);
      expect(row.scheduledStart?.toISOString()).toBe('2030-03-05T08:00:00.000Z');
      expect(row.scheduledEnd?.toISOString()).toBe('2030-03-05T08:45:00.000Z');
      expect(row.status).toBe('scheduled');
    });

    it('leaves in-progress, completed and unlinked meetings alone', async () => {
      const userId = `user_untouched_${next()}`;
      const live = await seedMeeting(userId, { status: 'in_progress' });
      const done = await seedMeeting(userId, { status: 'completed' });
      const unlinked = await seedMeeting(userId);
      const { eventId } = await createLinkedEvent(userId, live);
      // Point the other two meetings at the same event by hand (done) or not at all (unlinked).
      await db
        .update(schema.meetings)
        .set({ calendarEventId: eventId })
        .where(eq(schema.meetings.id, done.id));

      await send(userId, 'PATCH', `/${eventId}`, { title: 'Changed', startTime: '2030-05-01T10:00:00.000Z' });
      await send(userId, 'PATCH', `/${eventId}/cancel`);
      await send(userId, 'DELETE', `/${eventId}`);

      for (const [m, status] of [
        [live, 'in_progress'],
        [done, 'completed'],
      ] as const) {
        const row = await meetingRow(m.id);
        expect(row.status).toBe(status);
        expect(row.title).toBe('Planning');
        expect(row.scheduledStart?.toISOString()).toBe('2030-01-01T10:00:00.000Z');
      }
      const unlinkedRow = await meetingRow(unlinked.id);
      expect(unlinkedRow.status).toBe('scheduled');
      expect(unlinkedRow.title).toBe('Planning');
    });
  });
});
