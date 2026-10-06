/**
 * DB-backed integration tests for /api/booking-pages.
 *
 * The DB `duration` column is NOT NULL. The Zod schema exposes `durationMinutes`
 * (optional alias) but the insert spreads `...data` verbatim. We pass `duration`
 * directly via the passthrough schema to satisfy the DB constraint in tests.
 * The `availability` column is also NOT NULL, so we provide a minimal value.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookingPagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const emptyAvailability = {
  monday: [],
  tuesday: [],
  wednesday: [],
  thursday: [],
  friday: [],
  saturday: [],
  sunday: [],
};

/** Minimal valid payload satisfying both Zod and DB NOT NULL columns. */
const basePage = (suffix = '') => ({
  name: `Intro Call${suffix}`,
  slug: `intro-call${suffix}-${Date.now()}`,
  // DB NOT NULL fields passed via passthrough
  duration: 30,
  availability: emptyAvailability,
});

describe('/api/booking-pages · pglite integration', () => {
  it('POST / writes a booking page with ownerId from auth context', async () => {
    const { request } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: {
        permissions: permissions('bookings:create'),
        userId: 'user_bpg_creator',
        tenantDb: db,
      },
    });

    const res = await request('/api/booking-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basePage()),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^bpg_/);

    const [row] = await db
      .select()
      .from(schema.calendarBookingPages)
      .where(eq(schema.calendarBookingPages.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Intro Call');
    expect(row?.ownerId).toBe('user_bpg_creator');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:create'), userId: 'user_bpg_test', tenantDb: db },
    });
    const res = await request('/api/booking-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basePage(), name: '' }),
    });
    expect(res.status).toBe(400);
  });

  // ── Scope-isolation tests ────────────────────────────────────────────────

  it('GET / non-elevated user only sees own booking pages', async () => {
    const aliceId = 'user_scope_alice_bpg';
    const bobId = 'user_scope_bob_bpg';

    const { request: reqAlice } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:create'), userId: aliceId, tenantDb: db },
    });
    const { request: reqBob } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:create'), userId: bobId, tenantDb: db },
    });

    await reqAlice('/api/booking-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basePage('-alice')),
    });
    await reqBob('/api/booking-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basePage('-bob')),
    });

    const { request: listAlice } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:read'), userId: aliceId, tenantDb: db },
    });
    const listRes = await listAlice('/api/booking-pages');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { ownerId: string }[] };
    expect(listBody.data.every((r) => r.ownerId === aliceId)).toBe(true);
  });

  it('GET /:id non-elevated user gets 404 for another owner\'s booking page', async () => {
    const charlieId = 'user_scope_charlie_bpg';
    const { request: seed } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:create'), userId: charlieId, tenantDb: db },
    });
    const seedRes = await seed('/api/booking-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basePage('-charlie')),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const pageId = seedBody.data.id;

    const { request: reqDave } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:read'), userId: 'user_scope_dave_bpg', tenantDb: db },
    });
    const res = await reqDave(`/api/booking-pages/${pageId}`);
    expect(res.status).toBe(404);
  });

  it('GET /:id elevated user (bookings:scope:all) can read any booking page', async () => {
    const erinId = 'user_scope_erin_bpg';
    const { request: seed } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:create'), userId: erinId, tenantDb: db },
    });
    const seedRes = await seed('/api/booking-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basePage('-erin')),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const pageId = seedBody.data.id;

    const { request: reqAdmin } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: {
        permissions: permissions('bookings:read', 'bookings:scope:all'),
        userId: 'user_scope_admin_bpg',
        tenantDb: db,
      },
    });
    const res = await reqAdmin(`/api/booking-pages/${pageId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; ownerId: string } };
    expect(body.data.ownerId).toBe(erinId);
  });

  // ── Availability + question validation ──────────────────────────────────

  const JSON_HEADERS = { 'Content-Type': 'application/json' };
  const mondayOnly = (start: string, end: string) => ({ ...emptyAvailability, monday: [{ start, end }] });

  it('POST / rejects a range that ends before it starts (Monday 18:00-17:00)', async () => {
    const { request } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:create'), userId: 'user_bpg_avail', tenantDb: db },
    });
    const res = await request('/api/booking-pages', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...basePage('-badrange'), availability: mondayOnly('18:00', '17:00') }),
    });
    expect(res.status).toBe(400);
    // The standard error envelope, not zod-validator's `{ success: false, error: ZodError }`.
    const body = (await res.json()) as {
      success?: boolean;
      error: { code: string; message: string; details: { issues: Array<{ path: string; message: string }> } };
    };
    expect(body.success).toBeUndefined();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('availability.monday');
    expect(body.error.details.issues[0].path).toMatch(/^availability.monday/);
  });

  it('POST / rejects overlapping ranges on the same day but allows touching ranges', async () => {
    const { request } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:create'), userId: 'user_bpg_avail', tenantDb: db },
    });
    const overlap = await request('/api/booking-pages', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...basePage('-overlap'),
        availability: {
          ...emptyAvailability,
          monday: [
            { start: '09:00', end: '12:00' },
            { start: '11:00', end: '14:00' },
          ],
        },
      }),
    });
    expect(overlap.status).toBe(400);

    const touching = await request('/api/booking-pages', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...basePage('-touching'),
        availability: {
          ...emptyAvailability,
          monday: [
            { start: '09:00', end: '12:00' },
            { start: '12:00', end: '14:00' },
          ],
        },
      }),
    });
    expect(touching.status).toBe(201);
  });

  it('PATCH /:id rejects an invalid availability range', async () => {
    const { request } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: {
        permissions: permissions('bookings:create', 'bookings:update'),
        userId: 'user_bpg_avail_patch',
        tenantDb: db,
      },
    });
    const created = await request('/api/booking-pages', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(basePage('-patch-avail')),
    });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await request(`/api/booking-pages/${data.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ availability: mondayOnly('18:00', '17:00') }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('availability.monday');
  });

  it('persists custom form fields as questions on create and update', async () => {
    const { request } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: {
        permissions: permissions('bookings:create', 'bookings:update', 'bookings:read'),
        userId: 'user_bpg_questions',
        tenantDb: db,
      },
    });
    const questions = [
      { id: 'phone', label: 'Phone number', type: 'text', required: true },
      { id: 'topic', label: 'Topic', type: 'select', required: false, options: ['Sales', 'Support'] },
    ];
    const created = await request('/api/booking-pages', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...basePage('-questions'), questions }),
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const [row] = await db
      .select()
      .from(schema.calendarBookingPages)
      .where(eq(schema.calendarBookingPages.id, data.id))
      .limit(1);
    expect(row?.questions).toEqual(questions);

    const updated = await request(`/api/booking-pages/${data.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ questions: [questions[0]] }),
    });
    expect(updated.status).toBe(200);
    const [after] = await db
      .select()
      .from(schema.calendarBookingPages)
      .where(eq(schema.calendarBookingPages.id, data.id))
      .limit(1);
    expect(after?.questions).toEqual([questions[0]]);
  });

  it('rejects a select question without options', async () => {
    const { request } = createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions('bookings:create'), userId: 'user_bpg_questions', tenantDb: db },
    });
    const res = await request('/api/booking-pages', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...basePage('-badselect'),
        questions: [{ id: 'topic', label: 'Topic', type: 'select', required: false }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('/api/booking-pages · booking rules (TASK-892)', () => {
  const userId = 'user_bpg_rules';

  function api(...perms: Parameters<typeof permissions>) {
    return createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions(...perms), userId, tenantDb: db },
    }).request;
  }

  async function create(body: Record<string, unknown>) {
    const request = api('bookings:create');
    return request('/api/booking-pages', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...basePage('-rules'), ...body }),
    });
  }

  async function row(id: string) {
    const [r] = await db.select().from(schema.calendarBookingPages).where(eq(schema.calendarBookingPages.id, id));
    return r!;
  }

  it('persists minNotice, maxAdvance, dateOverrides and maxBookingsPerDay on create and patch', async () => {
    const dateOverrides = [
      { date: '2030-12-24', slots: [{ start: '09:00', end: '12:00' }] },
      { date: '2030-12-25', slots: [] },
    ];
    const created = await create({ minNotice: 120, maxAdvance: 30, dateOverrides, maxBookingsPerDay: 4 });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    let stored = await row(id);
    expect(stored.minNotice).toBe(120);
    expect(stored.maxAdvance).toBe(30);
    expect(stored.dateOverrides).toEqual(dateOverrides);
    expect(stored.maxBookingsPerDay).toBe(4);

    const patch = api('bookings:update');
    const res = await patch(`/api/booking-pages/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ minNotice: 0, maxAdvance: 1, dateOverrides: null, maxBookingsPerDay: null }),
    });
    expect(res.status).toBe(200);
    stored = await row(id);
    expect(stored.minNotice).toBe(0);
    expect(stored.maxAdvance).toBe(1);
    expect(stored.dateOverrides).toBeNull();
    expect(stored.maxBookingsPerDay).toBeNull();

    const zero = await patch(`/api/booking-pages/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ maxBookingsPerDay: 0 }),
    });
    expect(zero.status).toBe(200);
    expect((await row(id)).maxBookingsPerDay).toBe(0);
  });

  it('rejects out-of-range or malformed rule values', async () => {
    const bad: Record<string, unknown>[] = [
      { minNotice: -1 },
      { minNotice: 1.5 },
      { maxAdvance: 0 },
      { maxAdvance: 'soon' },
      { maxBookingsPerDay: -1 },
      { maxBookingsPerDay: 2.5 },
      { dateOverrides: [{ date: '2030-02-30', slots: [] }] },
      { dateOverrides: [{ date: '25-12-2030', slots: [] }] },
      { dateOverrides: [{ date: '2030-12-25', slots: [{ start: '12:00', end: '09:00' }] }] },
      { dateOverrides: [{ date: '2030-12-25', slots: [{ start: '09:00', end: '09:00' }] }] },
      {
        dateOverrides: [
          { date: '2030-12-25', slots: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] },
        ],
      },
      { dateOverrides: [{ date: '2030-12-25', slots: [{ start: '9:00', end: '10:00' }] }] },
      {
        dateOverrides: [
          { date: '2030-12-25', slots: [] },
          { date: '2030-12-25', slots: [{ start: '09:00', end: '10:00' }] },
        ],
      },
    ];
    for (const body of bad) {
      expect((await create(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accepts a full year of overrides and rejects more', async () => {
    const day = (i: number) => new Date(Date.UTC(2031, 0, 1 + i)).toISOString().slice(0, 10);
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ date: day(i), slots: [] }));
    expect((await create({ dateOverrides: make(366) })).status).toBe(201);
    expect((await create({ dateOverrides: make(367) })).status).toBe(400);
  });

  it('PATCH validates the same rules', async () => {
    const created = await create({});
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const patch = api('bookings:update');
    const res = await patch(`/api/booking-pages/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ maxAdvance: 0 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/booking-pages/:id/delete-impact (TASK-893)', () => {
  const ownerId = 'user_bpg_impact';
  const hour = 60 * 60 * 1000;

  function api(userId = ownerId, ...perms: Parameters<typeof permissions>) {
    return createTestApp('/api/booking-pages', bookingPagesRoutes, {
      context: { permissions: permissions(...(perms.length ? perms : ['bookings:delete'])), userId, tenantDb: db },
    }).request;
  }

  async function seedPage(): Promise<string> {
    const id = `bpg_impact_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await db.insert(schema.calendarBookingPages).values({
      id,
      name: 'Impact',
      slug: id,
      ownerId,
      duration: 30,
      availability: emptyAvailability,
    });
    return id;
  }

  async function seedBooking(pageId: string, startOffsetMs: number, status = 'confirmed', deleted = false) {
    const start = new Date(Date.now() + startOffsetMs);
    await db.insert(schema.calendarBookings).values({
      id: `bkg_${Math.random().toString(36).slice(2, 12)}`,
      bookingPageId: pageId,
      bookerName: 'B',
      bookerEmail: 'b@example.com',
      startTime: start,
      endTime: new Date(start.getTime() + 30 * 60000),
      status,
      deletedAt: deleted ? new Date() : null,
    });
  }

  it('counts only non-cancelled, non-deleted bookings that start in the future', async () => {
    const pageId = await seedPage();
    const otherPage = await seedPage();
    await seedBooking(pageId, 2 * hour);
    await seedBooking(pageId, 48 * hour);
    await seedBooking(pageId, 5 * hour, 'cancelled');
    await seedBooking(pageId, 6 * hour, 'confirmed', true);
    await seedBooking(pageId, -3 * hour);
    await seedBooking(otherPage, 2 * hour);

    const res = await api()(`/api/booking-pages/${pageId}/delete-impact`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { upcomingBookingCount: number } }).data).toEqual({
      upcomingBookingCount: 2,
    });
  });

  it('is 0 for a page without bookings and 404 for an unknown or deleted page', async () => {
    const pageId = await seedPage();
    const res = await api()(`/api/booking-pages/${pageId}/delete-impact`);
    expect(((await res.json()) as { data: { upcomingBookingCount: number } }).data.upcomingBookingCount).toBe(0);

    expect((await api()('/api/booking-pages/bpg_nope/delete-impact')).status).toBe(404);

    await db
      .update(schema.calendarBookingPages)
      .set({ deletedAt: new Date() })
      .where(eq(schema.calendarBookingPages.id, pageId));
    expect((await api()(`/api/booking-pages/${pageId}/delete-impact`)).status).toBe(404);
  });

  it('needs bookings:delete and respects owner scoping', async () => {
    const pageId = await seedPage();
    expect((await api(ownerId, 'bookings:read')(`/api/booking-pages/${pageId}/delete-impact`)).status).toBe(403);
    expect((await api('user_bpg_impact_other')(`/api/booking-pages/${pageId}/delete-impact`)).status).toBe(404);
    expect(
      (await api('user_bpg_impact_other', 'bookings:delete', 'bookings:scope:all')(
        `/api/booking-pages/${pageId}/delete-impact`,
      )).status,
    ).toBe(200);
  });
});
