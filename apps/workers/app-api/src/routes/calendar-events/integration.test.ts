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
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

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
});
