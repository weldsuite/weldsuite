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
