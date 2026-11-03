/**
 * Personal booking pages and bookings: `/api/booking-pages` (with the
 * available-slots calculation) and `/api/bookings`, on pglite, refusals
 * included. Run on both backends by the `personal: booking` conformance suite.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as personalSchema from '@weldsuite/db/schema/personal';
import { createMasterPgliteDb, createPersonalPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing/conformance';
import { authHeaders, createPersonalTestApp } from '../test/harness';
import { ACCOUNT, AT, OTHER_ACCOUNT, OTHER_USER, USER, resetDatabases, seedBothAccounts } from '../test/seed';

const holder = vi.hoisted(() => ({ masterDb: null as unknown, personalDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
  getPersonalDb: () => conformanceTenantDb(holder.personalDb),
}));

type Db = Awaited<ReturnType<typeof createPersonalPgliteDb>>['db'];
let masterDb: Db;
let personalDb: Db;

const PRO = { pla: 'u:weldcalendar_pro' };
const WEEKDAYS = [{ start: '09:00', end: '12:00' }];
const AVAILABILITY = {
  monday: WEEKDAYS,
  tuesday: [{ start: '09:00', end: '10:30' }, { start: '14:00', end: '15:00' }],
  wednesday: WEEKDAYS,
  thursday: WEEKDAYS,
  friday: [],
  saturday: [],
  sunday: [],
};

beforeAll(async () => {
  masterDb = (await createMasterPgliteDb()).db;
  personalDb = (await createPersonalPgliteDb()).db;
  holder.masterDb = masterDb;
  holder.personalDb = personalDb;
}, 60_000);

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetDatabases(masterDb, personalDb);
  await seedBothAccounts(masterDb);
});

function app() {
  return createPersonalTestApp({ masterDb, personalDb });
}

function page(id: string, fields: Partial<typeof personalSchema.personalCalendarBookingPages.$inferInsert>) {
  return {
    id,
    personalAccountId: ACCOUNT,
    name: id,
    slug: id.replace('_', '-'),
    ownerId: USER,
    duration: 30,
    availability: AVAILABILITY,
    timezone: 'Europe/Amsterdam',
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

async function seedPages() {
  await personalDb.insert(personalSchema.personalCalendarBookingPages).values([
    page('pbp_intro', { name: 'Intro call', slug: 'intro-call', createdAt: new Date('2026-10-01T09:00:01.000Z') }),
    page('pbp_deep', {
      name: 'Deep dive',
      slug: 'deep-dive',
      duration: 60,
      bufferBefore: 15,
      bufferAfter: 15,
      minNotice: 0,
      createdAt: new Date('2026-10-01T09:00:02.000Z'),
    }),
    page('pbp_utc', { name: 'Coffee', slug: 'coffee', timezone: 'UTC', createdAt: new Date('2026-10-01T09:00:03.000Z') }),
    page('pbp_gone', { slug: 'gone', deletedAt: AT }),
    page('pbp_theirs', { personalAccountId: OTHER_ACCOUNT, ownerId: OTHER_USER, slug: 'theirs' }),
  ]);
}

const VALID_PAGE = {
  name: 'Office hours',
  slug: 'office-hours',
  duration: 45,
  availability: AVAILABILITY,
};

describe('/api/booking-pages', () => {
  it('lists pages newest first, with search and a cursor', async () => {
    await seedPages();
    const target = app();
    const all = await target.request('/api/booking-pages', { headers: authHeaders() });
    expect(all.status).toBe(200);
    const body = (await all.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(body.data.map((p) => p.id)).toEqual(['pbp_utc', 'pbp_deep', 'pbp_intro']);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    const searched = await target.request('/api/booking-pages?search=dive', { headers: authHeaders() });
    expect(((await searched.json()) as { data: Array<{ id: string }> }).data.map((p) => p.id)).toEqual(['pbp_deep']);
    const bySlug = await target.request('/api/booking-pages?search=coff', { headers: authHeaders() });
    expect(((await bySlug.json()) as { data: Array<{ id: string }> }).data.map((p) => p.id)).toEqual(['pbp_utc']);

    const first = await target.request('/api/booking-pages?limit=2', { headers: authHeaders() });
    const page1 = (await first.json()) as { data: Array<{ id: string }>; pagination: { cursor: string } };
    expect(page1.data.map((p) => p.id)).toEqual(['pbp_utc', 'pbp_deep']);
    expect(page1.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'pbp_deep' });
    const second = await target.request('/api/booking-pages?limit=2&cursor=pbp_deep', { headers: authHeaders() });
    expect(((await second.json()) as { data: Array<{ id: string }> }).data.map((p) => p.id)).toEqual(['pbp_intro']);
  });

  it('creates a page within the plan, with its defaults', async () => {
    const target = app();
    const res = await target.request('/api/booking-pages', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        ...VALID_PAGE,
        questions: [{ id: 'q1', label: 'Topic', type: 'select', required: true, options: ['A', 'B'] }],
        locationType: 'video',
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await personalDb
      .select()
      .from(personalSchema.personalCalendarBookingPages)
      .where(eq(personalSchema.personalCalendarBookingPages.id, data.id));
    expect(row).toMatchObject({
      personalAccountId: ACCOUNT,
      ownerId: USER,
      duration: 45,
      bufferBefore: 0,
      bufferAfter: 0,
      isActive: true,
      minNotice: 60,
      maxAdvance: 60,
      timezone: 'UTC',
      locationType: 'video',
      description: null,
    });

    const limited = await target.request('/api/booking-pages', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...VALID_PAGE, slug: 'second' }),
    });
    expect(limited.status).toBe(403);
    expect(await limited.json()).toEqual({
      error: {
        code: 'PLAN_LIMIT_REACHED',
        message: 'Booking page limit reached for your plan',
        details: { maxBookingPages: 1 },
      },
    });
  });

  it('refuses a slug someone already has', async () => {
    await seedPages();
    const res = await app().request('/api/booking-pages', {
      method: 'POST',
      headers: authHeaders(PRO),
      body: JSON.stringify({ ...VALID_PAGE, slug: 'theirs' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'That booking slug is already taken' } });
  });

  it('refuses a body that does not parse', async () => {
    const res = await app().request('/api/booking-pages', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'x',
        slug: 'Not A Slug',
        duration: 4.5,
        bufferBefore: -1,
        locationType: 'moon',
        availability: { monday: [] },
        questions: [{ id: 'q', label: 'Q', type: 'radio', required: 'yes' }],
        maxAdvance: 400,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('reads, toggles, updates and deletes a page', async () => {
    await seedPages();
    const target = app();
    const got = await target.request('/api/booking-pages/pbp_intro', { headers: authHeaders() });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ data: { id: 'pbp_intro', slug: 'intro-call', availability: AVAILABILITY } });

    const toggled = await target.request('/api/booking-pages/pbp_intro/toggle', { method: 'PATCH', headers: authHeaders() });
    expect(await toggled.json()).toEqual({ data: { id: 'pbp_intro', isActive: false } });
    const back = await target.request('/api/booking-pages/pbp_intro/toggle', { method: 'PATCH', headers: authHeaders() });
    expect(await back.json()).toEqual({ data: { id: 'pbp_intro', isActive: true } });

    const patched = await target.request('/api/booking-pages/pbp_intro', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'First call', slug: 'first-call', duration: 20, questions: [], description: 'Say hi' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ data: { id: 'pbp_intro' } });
    const [row] = await personalDb
      .select()
      .from(personalSchema.personalCalendarBookingPages)
      .where(eq(personalSchema.personalCalendarBookingPages.id, 'pbp_intro'));
    expect(row).toMatchObject({ name: 'First call', slug: 'first-call', duration: 20, questions: [], description: 'Say hi' });

    // Its own slug again is fine; another page's is not.
    const same = await target.request('/api/booking-pages/pbp_intro', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ slug: 'first-call' }),
    });
    expect(same.status).toBe(200);
    const taken = await target.request('/api/booking-pages/pbp_intro', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ slug: 'coffee' }),
    });
    expect(taken.status).toBe(409);

    const removed = await target.request('/api/booking-pages/pbp_intro', { method: 'DELETE', headers: authHeaders() });
    expect(removed.status).toBe(204);

    for (const [method, path] of [
      ['GET', '/api/booking-pages/pbp_intro'],
      ['GET', '/api/booking-pages/pbp_theirs'],
      ['PATCH', '/api/booking-pages/pbp_theirs/toggle'],
      ['PATCH', '/api/booking-pages/pbp_theirs'],
      ['DELETE', '/api/booking-pages/pbp_gone'],
    ] as const) {
      const res = await target.request(path, {
        method,
        headers: authHeaders(),
        body: method === 'PATCH' && !path.endsWith('toggle') ? JSON.stringify({ name: 'x' }) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const missing = await target.request('/api/booking-pages/pbp_gone', { headers: authHeaders() });
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Booking page with ID 'pbp_gone' not found" } });
  });

  describe('available slots', () => {
    beforeEach(async () => {
      await seedPages();
      // 2030-03-04 is a Monday, 2030-03-05 a Tuesday.
      await personalDb.insert(personalSchema.personalCalendars).values({
        id: 'pcal_home',
        personalAccountId: ACCOUNT,
        name: 'Home',
        ownerId: USER,
        isDefault: true,
        createdAt: AT,
        updatedAt: AT,
      });
      await personalDb.insert(personalSchema.personalCalendarEvents).values([
        {
          id: 'pevt_busy',
          personalAccountId: ACCOUNT,
          calendarId: 'pcal_home',
          title: 'Busy',
          type: 'meeting',
          // 10:00–10:45 in Amsterdam (UTC+1 in March before DST).
          startTime: new Date('2030-03-04T09:00:00.000Z'),
          endTime: new Date('2030-03-04T09:45:00.000Z'),
          organizerId: USER,
          createdAt: AT,
          updatedAt: AT,
        },
        {
          id: 'pevt_open_end',
          personalAccountId: ACCOUNT,
          calendarId: 'pcal_home',
          title: 'No end',
          type: 'meeting',
          startTime: new Date('2030-03-05T13:00:00.000Z'),
          organizerId: USER,
          createdAt: AT,
          updatedAt: AT,
        },
        {
          id: 'pevt_cancelled',
          personalAccountId: ACCOUNT,
          calendarId: 'pcal_home',
          title: 'Cancelled',
          type: 'meeting',
          status: 'cancelled',
          startTime: new Date('2030-03-04T08:00:00.000Z'),
          endTime: new Date('2030-03-04T11:00:00.000Z'),
          organizerId: USER,
          createdAt: AT,
          updatedAt: AT,
        },
      ]);
    });

    it('walks the day in the page’s zone around the owner’s events', async () => {
      const target = app();
      const monday = await target.request('/api/booking-pages/pbp_intro/available-slots?date=2030-03-04', {
        headers: authHeaders(),
      });
      expect(monday.status).toBe(200);
      const { data } = (await monday.json()) as { data: Array<{ start: string; end: string; available: boolean }> };
      expect(data).toHaveLength(6);
      expect(data[0]).toEqual({ start: '2030-03-04T08:00:00.000Z', end: '2030-03-04T08:30:00.000Z', available: true });
      expect(data.filter((s) => !s.available).map((s) => s.start)).toEqual([
        '2030-03-04T09:00:00.000Z',
        '2030-03-04T09:30:00.000Z',
      ]);

      const tuesday = await target.request('/api/booking-pages/pbp_deep/available-slots?date=2030-03-05', {
        headers: authHeaders(),
      });
      // One hour from each window; the afternoon one overlaps an event with no end (30 minutes).
      expect(((await tuesday.json()) as { data: Array<{ available: boolean }> }).data.map((s) => s.available)).toEqual([
        true,
        false,
      ]);

      const utc = await target.request('/api/booking-pages/pbp_utc/available-slots?date=2030-03-05', {
        headers: authHeaders(),
      });
      expect(((await utc.json()) as { data: Array<{ start: string }> }).data.map((s) => s.start)).toContain(
        '2030-03-05T14:30:00.000Z',
      );

      const friday = await target.request('/api/booking-pages/pbp_intro/available-slots?date=2030-03-08', {
        headers: authHeaders(),
      });
      expect(await friday.json()).toEqual({ data: [] });

      // Across the switch to summer time (2030-03-31 in Amsterdam).
      const dst = await target.request('/api/booking-pages/pbp_intro/available-slots?date=2030-04-01', {
        headers: authHeaders(),
      });
      expect(((await dst.json()) as { data: Array<{ start: string }> }).data[0]?.start).toBe('2030-04-01T07:00:00.000Z');
    });

    it('marks slots inside the minimum notice unavailable', async () => {
      const res = await app().request('/api/booking-pages/pbp_intro/available-slots?date=2020-03-02', {
        headers: authHeaders(),
      });
      const { data } = (await res.json()) as { data: Array<{ available: boolean }> };
      expect(data.length).toBeGreaterThan(0);
      expect(data.every((s) => !s.available)).toBe(true);
    });

    it('refuses a missing or broken date, and another person’s page', async () => {
      const target = app();
      expect((await target.request('/api/booking-pages/pbp_intro/available-slots', { headers: authHeaders() })).status).toBe(400);
      const broken = await target.request('/api/booking-pages/pbp_intro/available-slots?date=someday', {
        headers: authHeaders(),
      });
      expect(broken.status).toBe(500);
      expect(await broken.json()).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to compute available slots' },
      });
      const theirs = await target.request('/api/booking-pages/pbp_theirs/available-slots?date=2030-03-04', {
        headers: authHeaders(),
      });
      expect(theirs.status).toBe(404);
    });
  });
});

describe('/api/bookings', () => {
  beforeEach(async () => {
    await seedPages();
    await personalDb.insert(personalSchema.personalCalendars).values({
      id: 'pcal_home',
      personalAccountId: ACCOUNT,
      name: 'Home',
      ownerId: USER,
      isDefault: true,
      createdAt: AT,
      updatedAt: AT,
    });
    await personalDb.insert(personalSchema.personalCalendarEvents).values({
      id: 'pevt_booked',
      personalAccountId: ACCOUNT,
      calendarId: 'pcal_home',
      title: 'Intro with Sam',
      type: 'meeting',
      startTime: new Date('2030-03-04T09:00:00.000Z'),
      organizerId: USER,
      createdAt: AT,
      updatedAt: AT,
    });
    const booking = (id: string, fields: Partial<typeof personalSchema.personalCalendarBookings.$inferInsert>) => ({
      id,
      personalAccountId: ACCOUNT,
      bookingPageId: 'pbp_intro',
      bookerName: 'Sam',
      bookerEmail: 'sam@example.com',
      startTime: new Date('2030-03-04T09:00:00.000Z'),
      endTime: new Date('2030-03-04T09:30:00.000Z'),
      createdAt: AT,
      updatedAt: AT,
      ...fields,
    });
    await personalDb.insert(personalSchema.personalCalendarBookings).values([
      booking('pbk_a', { calendarEventId: 'pevt_booked', answers: { q1: 'A' }, createdAt: new Date('2026-10-01T09:00:01.000Z') }),
      booking('pbk_b', { bookingPageId: 'pbp_deep', status: 'cancelled', createdAt: new Date('2026-10-01T09:00:02.000Z') }),
      booking('pbk_c', { createdAt: new Date('2026-10-01T09:00:03.000Z') }),
      booking('pbk_gone', { deletedAt: AT }),
      booking('pbk_theirs', { personalAccountId: OTHER_ACCOUNT, bookingPageId: 'pbp_theirs' }),
    ]);
  });

  it('lists bookings newest first, with filters and a cursor', async () => {
    const target = app();
    const all = await target.request('/api/bookings', { headers: authHeaders() });
    const body = (await all.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(body.data.map((b) => b.id)).toEqual(['pbk_c', 'pbk_b', 'pbk_a']);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    for (const [query, ids] of [
      ['bookingPageId=pbp_intro', ['pbk_c', 'pbk_a']],
      ['status=cancelled', ['pbk_b']],
      ['limit=1', ['pbk_c']],
      ['limit=2&cursor=pbk_b', ['pbk_a']],
    ] as const) {
      const res = await target.request(`/api/bookings?${query}`, { headers: authHeaders() });
      const { data, pagination } = (await res.json()) as { data: Array<{ id: string }>; pagination: { totalCount: number } };
      expect(data.map((b) => b.id), query).toEqual(ids);
      // The total ignores the filters.
      expect(pagination.totalCount, query).toBe(3);
    }
  });

  it('reads one booking', async () => {
    const target = app();
    const res = await target.request('/api/bookings/pbk_a', { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { id: 'pbk_a', bookerEmail: 'sam@example.com', answers: { q1: 'A' } } });
    const theirs = await target.request('/api/bookings/pbk_theirs', { headers: authHeaders() });
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Booking with ID 'pbk_theirs' not found" } });
  });

  it('cancels a booking and its event', async () => {
    const target = app();
    const res = await target.request('/api/bookings/pbk_a/cancel', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ cancelReason: 'Ill' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'pbk_a', status: 'cancelled' } });
    const [booking] = await personalDb
      .select()
      .from(personalSchema.personalCalendarBookings)
      .where(eq(personalSchema.personalCalendarBookings.id, 'pbk_a'));
    expect(booking).toMatchObject({ status: 'cancelled', cancelReason: 'Ill' });
    expect(booking?.cancelledAt).toBeInstanceOf(Date);
    const [evt] = await personalDb
      .select()
      .from(personalSchema.personalCalendarEvents)
      .where(eq(personalSchema.personalCalendarEvents.id, 'pevt_booked'));
    expect(evt?.status).toBe('cancelled');

    const noReason = await target.request('/api/bookings/pbk_c/cancel', { method: 'PATCH', headers: authHeaders(), body: '{}' });
    expect(noReason.status).toBe(200);

    const tooLong = await target.request('/api/bookings/pbk_c/cancel', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ cancelReason: 'x'.repeat(501) }),
    });
    expect(tooLong.status).toBe(400);
    const theirs = await target.request('/api/bookings/pbk_theirs/cancel', { method: 'PATCH', headers: authHeaders(), body: '{}' });
    expect(theirs.status).toBe(404);
  });

  it('deletes a booking', async () => {
    const target = app();
    expect((await target.request('/api/bookings/pbk_c', { method: 'DELETE', headers: authHeaders() })).status).toBe(204);
    expect((await target.request('/api/bookings/pbk_c', { method: 'DELETE', headers: authHeaders() })).status).toBe(404);
  });
});
