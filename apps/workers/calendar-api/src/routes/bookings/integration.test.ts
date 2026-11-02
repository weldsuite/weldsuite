/**
 * DB-backed integration tests for /api/bookings: owner scoping through the
 * booking page, paging, validation, and the passthrough writes.
 *
 * `POST /` cannot store a booking: the shared schema names the times
 * `startsAt`/`endsAt`, while the NOT NULL `start_time`/`end_time` columns are
 * `timestamp`s that Drizzle maps with `toISOString()`, which a JSON value
 * doesn't have. The tests pin what the route answers today.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookingsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const OWNER = 'user_bk_owner';
const OTHER = 'user_bk_other';

let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

function api(userId: string, ...perms: string[]) {
  return createTestApp('/api/bookings', bookingsRoutes, {
    context: { permissions: permissions(...perms), userId, tenantDb: db },
  }).request;
}

async function seedPage(ownerId = OWNER): Promise<string> {
  const id = `bpg_bk_${next()}`;
  await db.insert(schema.calendarBookingPages).values({
    id,
    name: 'Intro',
    slug: id,
    ownerId,
    duration: 30,
    availability: { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] },
  });
  return id;
}

async function seedBooking(pageId: string, extra: Partial<typeof schema.calendarBookings.$inferInsert> = {}) {
  const id = `bk_${next()}`;
  const start = new Date(Date.UTC(2030, 0, 10, 9, 0));
  await db.insert(schema.calendarBookings).values({
    id,
    bookingPageId: pageId,
    bookerName: 'Booker',
    bookerEmail: 'booker@example.com',
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    createdAt: new Date(Date.UTC(2029, 0, 1, 0, 0, seq)),
    ...extra,
  });
  return id;
}

async function row(id: string) {
  const [r] = await db.select().from(schema.calendarBookings).where(eq(schema.calendarBookings.id, id));
  return r;
}

describe('/api/bookings · list', () => {
  it('scopes to the caller\'s own pages, filters by page and status, and pages by cursor', async () => {
    const page = await seedPage();
    const otherPage = await seedPage(OTHER);
    const a = await seedBooking(page);
    const b = await seedBooking(page, { status: 'cancelled' });
    const c = await seedBooking(page);
    await seedBooking(otherPage);

    const own = await api(OWNER, 'bookings:read')(`/api/bookings?bookingPageId=${page}`);
    expect(own.status).toBe(200);
    const body = (await own.json()) as { data: { id: string }[]; pagination: { totalCount: number } };
    expect(body.data.map((r) => r.id)).toEqual([c, b, a]);
    expect(body.pagination.totalCount).toBe(3);

    const cancelled = await api(OWNER, 'bookings:read')(`/api/bookings?status=cancelled&bookingPageId=${page}`);
    expect(((await cancelled.json()) as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([b]);

    const first = await api(OWNER, 'bookings:read')(`/api/bookings?bookingPageId=${page}&limit=2`);
    const firstBody = (await first.json()) as { data: { id: string }[]; pagination: { hasMore: boolean; cursor: string } };
    expect(firstBody.pagination.hasMore).toBe(true);
    const second = await api(OWNER, 'bookings:read')(
      `/api/bookings?bookingPageId=${page}&limit=2&cursor=${firstBody.pagination.cursor}`,
    );
    expect(((await second.json()) as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([a]);
  });

  it('shows another owner\'s bookings only with bookings:scope:all', async () => {
    const otherPage = await seedPage(OTHER);
    const id = await seedBooking(otherPage);
    const scoped = await api(OWNER, 'bookings:read')(`/api/bookings?bookingPageId=${otherPage}`);
    expect(((await scoped.json()) as { data: unknown[] }).data).toEqual([]);
    const all = await api(OWNER, 'bookings:read', 'bookings:scope:all')(`/api/bookings?bookingPageId=${otherPage}`);
    expect(((await all.json()) as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([id]);
  });

  it('reads odd limits and unknown cursors the way the route parses them', async () => {
    const page = await seedPage();
    await seedBooking(page);
    await seedBooking(page);
    for (const query of ['limit=abc', 'limit=0', 'limit=-1', 'limit=500', 'cursor=bk_missing', 'cursor=bk_missing&status=confirmed']) {
      const res = await api(OWNER, 'bookings:read')(`/api/bookings?bookingPageId=${page}&${query}`);
      expect(res.status, query).toBe(200);
    }
  });

  it('needs bookings:read', async () => {
    expect((await api(OWNER)('/api/bookings')).status).toBe(403);
  });
});

describe('/api/bookings/:id', () => {
  it('reads a booking on the caller\'s page, 403 on someone else\'s, 404 when missing or deleted', async () => {
    const page = await seedPage();
    const id = await seedBooking(page);
    const res = await api(OWNER, 'bookings:read')(`/api/bookings/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe(id);

    const denied = await api(OTHER, 'bookings:read')(`/api/bookings/${id}`);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { message: string } }).error.message).toBe(
      'You do not have access to this booking',
    );
    expect((await api(OTHER, 'bookings:read', 'bookings:scope:all')(`/api/bookings/${id}`)).status).toBe(200);

    expect((await api(OWNER, 'bookings:read')('/api/bookings/bk_missing')).status).toBe(404);
    const gone = await seedBooking(page, { deletedAt: new Date() });
    expect((await api(OWNER, 'bookings:read')(`/api/bookings/${gone}`)).status).toBe(404);
  });
});

describe('POST /api/bookings', () => {
  const body = (pageId: string) => ({
    bookingPageId: pageId,
    startsAt: '2030-01-10T09:00:00.000Z',
    endsAt: '2030-01-10T09:30:00.000Z',
    bookerName: 'Guest',
    bookerEmail: 'guest@example.com',
  });

  it('validates the body', async () => {
    const page = await seedPage();
    const request = api(OWNER, 'bookings:create');
    const missing = await request('/api/bookings', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
    const badEmail = await request('/api/bookings', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...body(page), customerEmail: 'nope' }),
    });
    expect(badEmail.status).toBe(400);
  });

  it('refuses a page the caller does not own', async () => {
    const page = await seedPage(OTHER);
    const res = await api(OWNER, 'bookings:create')('/api/bookings', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body(page)),
    });
    expect(res.status).toBe(403);
  });

  it('cannot store the booking: the time columns never get a value', async () => {
    const page = await seedPage();
    const res = await api(OWNER, 'bookings:create')('/api/bookings', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body(page)),
    });
    expect(res.status).toBe(500);
    const withTimes = await api(OWNER, 'bookings:create', 'bookings:scope:all')('/api/bookings', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...body(page), startTime: '2030-01-10T09:00:00.000Z', endTime: '2030-01-10T09:30:00.000Z' }),
    });
    expect(withTimes.status).toBe(500);
  });

  it('needs bookings:create', async () => {
    expect((await api(OWNER)('/api/bookings', { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(403);
  });
});

describe('PATCH /api/bookings/:id', () => {
  it('writes the column keys of the body and publishes the update', async () => {
    const page = await seedPage();
    const id = await seedBooking(page);
    const res = await api(OWNER, 'bookings:update')(`/api/bookings/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'cancelled', notes: 'Moved', cancelReason: 'Ill', answers: { q: 'a' }, customerName: 'ignored' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id } });
    const stored = await row(id);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.notes).toBe('Moved');
    expect(stored?.cancelReason).toBe('Ill');
    expect(stored?.answers).toEqual({ q: 'a' });
  });

  it('answers 500 for a time column sent as a string (Drizzle needs a Date)', async () => {
    const page = await seedPage();
    const id = await seedBooking(page);
    const res = await api(OWNER, 'bookings:update')(`/api/bookings/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ startTime: '2030-01-11T09:00:00.000Z' }),
    });
    expect(res.status).toBe(500);
    expect((await row(id))?.startTime.toISOString()).toBe('2030-01-10T09:00:00.000Z');
  });

  it('is scoped and validated', async () => {
    const page = await seedPage();
    const id = await seedBooking(page);
    const patch = (userId: string, body: unknown, ...perms: string[]) =>
      api(userId, 'bookings:update', ...perms)(`/api/bookings/${id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
    expect((await patch(OTHER, { status: 'x' })).status).toBe(403);
    expect((await patch(OWNER, { status: 'x'.repeat(31) })).status).toBe(400);
    expect((await api(OWNER, 'bookings:update')('/api/bookings/bk_missing', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: '{}',
    })).status).toBe(404);
  });
});

describe('DELETE /api/bookings/:id', () => {
  it('soft-deletes a booking on the caller\'s page', async () => {
    const page = await seedPage();
    const id = await seedBooking(page);
    expect((await api(OTHER, 'bookings:delete')(`/api/bookings/${id}`, { method: 'DELETE' })).status).toBe(403);
    const res = await api(OWNER, 'bookings:delete')(`/api/bookings/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await row(id))?.deletedAt).not.toBeNull();
    expect((await api(OWNER, 'bookings:delete')(`/api/bookings/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api(OWNER)(`/api/bookings/${id}`, { method: 'DELETE' })).status).toBe(403);
  });
});
