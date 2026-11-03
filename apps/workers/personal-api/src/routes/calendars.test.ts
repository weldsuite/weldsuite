/**
 * Personal WeldCalendar: `/api/calendars` and `/api/calendar-events` on
 * pglite (master + personal databases), refusals included. Run on both
 * backends by the `personal: calendar` conformance suite.
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

async function seedCalendars() {
  await personalDb.insert(personalSchema.personalCalendars).values([
    { id: 'pcal_work', personalAccountId: ACCOUNT, name: 'Work', ownerId: USER, isDefault: false, createdAt: AT, updatedAt: AT },
    { id: 'pcal_home', personalAccountId: ACCOUNT, name: 'Home', color: '#3b82f6', ownerId: USER, isDefault: true, createdAt: AT, updatedAt: AT },
    { id: 'pcal_alpha', personalAccountId: ACCOUNT, name: 'Alpha', ownerId: USER, isDefault: false, createdAt: AT, updatedAt: AT },
    { id: 'pcal_gone', personalAccountId: ACCOUNT, name: 'Gone', ownerId: USER, createdAt: AT, updatedAt: AT, deletedAt: AT },
    { id: 'pcal_theirs', personalAccountId: OTHER_ACCOUNT, name: 'Theirs', ownerId: OTHER_USER, isDefault: true, createdAt: AT, updatedAt: AT },
  ]);
}

function event(id: string, fields: Partial<typeof personalSchema.personalCalendarEvents.$inferInsert>) {
  return {
    id,
    personalAccountId: ACCOUNT,
    calendarId: 'pcal_home',
    title: id,
    type: 'meeting',
    startTime: new Date('2030-03-04T10:00:00.000Z'),
    organizerId: USER,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

async function seedEvents() {
  await personalDb.insert(personalSchema.personalCalendarEvents).values([
    event('pevt_a', { title: 'Standup', startTime: new Date('2030-03-04T09:00:00.000Z'), createdAt: new Date('2026-10-01T09:00:01.000Z') }),
    event('pevt_b', { title: 'Lunch with Sam', type: 'event', description: 'Pizza', startTime: new Date('2030-03-05T12:00:00.000Z'), createdAt: new Date('2026-10-01T09:00:02.000Z') }),
    event('pevt_c', { title: 'Review', calendarId: 'pcal_work', status: 'tentative', startTime: new Date('2030-03-06T15:00:00.000Z'), createdAt: new Date('2026-10-01T09:00:03.000Z') }),
    event('pevt_d', { title: 'Dentist', type: 'appointment', startTime: new Date('2030-03-07T08:30:00.000Z'), createdAt: new Date('2026-10-01T09:00:03.000Z') }),
    event('pevt_gone', { deletedAt: AT }),
    event('pevt_theirs', { personalAccountId: OTHER_ACCOUNT, calendarId: 'pcal_theirs', organizerId: OTHER_USER }),
  ]);
}

describe('/api/calendars', () => {
  it('lists the calendars, the default first, then by name', async () => {
    await seedCalendars();
    const res = await app().request('/api/calendars', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; isOwn: boolean; permission: string }>; pagination: unknown };
    expect(body.data.map((c) => c.id)).toEqual(['pcal_home', 'pcal_alpha', 'pcal_work']);
    expect(body.data[0]).toMatchObject({ isOwn: true, permission: 'manage' });
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
  });

  it('makes the default calendar once', async () => {
    const target = app();
    const created = await target.request('/api/calendars/ensure-default', { method: 'POST', headers: authHeaders() });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string; name: string; isDefault: boolean } };
    expect(data).toMatchObject({ name: 'My Calendar', color: '#3b82f6', ownerId: USER, isDefault: true, isOwn: true });

    const again = await target.request('/api/calendars/ensure-default', { method: 'POST', headers: authHeaders() });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(data.id);
  });

  it('creates a calendar within the plan', async () => {
    const target = app();
    const first = await target.request('/api/calendars', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Sport', description: 'Matches', color: '#00ff00' }),
    });
    expect(first.status).toBe(201);
    const { data } = (await first.json()) as { data: { id: string } };
    const [row] = await personalDb
      .select()
      .from(personalSchema.personalCalendars)
      .where(eq(personalSchema.personalCalendars.id, data.id));
    expect(row).toMatchObject({ name: 'Sport', description: 'Matches', isDefault: false, ownerId: USER });

    // Free: one calendar.
    const second = await target.request('/api/calendars', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Second' }),
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({
      error: {
        code: 'PLAN_LIMIT_REACHED',
        message: 'Calendar limit reached for your plan',
        details: { maxCalendars: 1 },
      },
    });

    // Pro: ten.
    const pro = await target.request('/api/calendars', {
      method: 'POST',
      headers: authHeaders(PRO),
      body: JSON.stringify({ name: 'Second' }),
    });
    expect(pro.status).toBe(201);
  });

  it('refuses a calendar without a name', async () => {
    const res = await app().request('/api/calendars', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: '', color: 'a-very-long-colour-name-indeed' }),
    });
    expect(res.status).toBe(400);
  });

  it('reads, updates and deletes one calendar', async () => {
    await seedCalendars();
    const target = app();
    const got = await target.request('/api/calendars/pcal_work', { headers: authHeaders() });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ data: { id: 'pcal_work', name: 'Work', isOwn: true, permission: 'manage' } });

    const patched = await target.request('/api/calendars/pcal_work', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Office', color: '#111111' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ data: { id: 'pcal_work' } });
    const [row] = await personalDb
      .select()
      .from(personalSchema.personalCalendars)
      .where(eq(personalSchema.personalCalendars.id, 'pcal_work'));
    expect(row).toMatchObject({ name: 'Office', color: '#111111', description: null });

    const removed = await target.request('/api/calendars/pcal_work', { method: 'DELETE', headers: authHeaders() });
    expect(removed.status).toBe(204);
    expect((await target.request('/api/calendars/pcal_work', { headers: authHeaders() })).status).toBe(404);
  });

  it('keeps the default calendar and other people’s', async () => {
    await seedCalendars();
    const target = app();
    const def = await target.request('/api/calendars/pcal_home', { method: 'DELETE', headers: authHeaders() });
    expect(def.status).toBe(400);
    expect(await def.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Cannot delete the default calendar' } });

    const theirs = await target.request('/api/calendars/pcal_theirs', { headers: authHeaders() });
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Calendar with ID 'pcal_theirs' not found" },
    });
    for (const [method, body] of [
      ['PATCH', JSON.stringify({ name: 'Mine now' })],
      ['DELETE', undefined],
    ] as const) {
      const res = await target.request('/api/calendars/pcal_theirs', { method, headers: authHeaders(), body });
      expect(res.status).toBe(404);
    }
    const invalid = await target.request('/api/calendars/pcal_work', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: '' }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe('/api/calendar-events', () => {
  beforeEach(async () => {
    await seedCalendars();
    await seedEvents();
  });

  it('lists events newest first, with the filters', async () => {
    const target = app();
    const all = await target.request('/api/calendar-events', { headers: authHeaders() });
    expect(all.status).toBe(200);
    const body = (await all.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(body.data.map((e) => e.id)).toEqual(['pevt_d', 'pevt_c', 'pevt_b', 'pevt_a']);
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });

    for (const [query, ids] of [
      ['type=event', ['pevt_b']],
      ['status=tentative', ['pevt_c']],
      ['calendarIds=pcal_work,%20pcal_theirs', ['pevt_c']],
      ['startDate=2030-03-05&endDate=2030-03-06T23:00:00Z', ['pevt_c', 'pevt_b']],
      ['search=Sam', ['pevt_b']],
      ['search=Pizz', ['pevt_b']],
      ['search=sam', []],
    ] as const) {
      const res = await target.request(`/api/calendar-events?${query}`, { headers: authHeaders() });
      expect(res.status, query).toBe(200);
      const { data } = (await res.json()) as { data: Array<{ id: string }> };
      expect(data.map((e) => e.id), query).toEqual(ids);
    }
  });

  it('pages with a cursor', async () => {
    const target = app();
    const first = await target.request('/api/calendar-events?limit=2', { headers: authHeaders() });
    const page1 = (await first.json()) as { data: Array<{ id: string }>; pagination: { cursor: string; hasMore: boolean } };
    expect(page1.data.map((e) => e.id)).toEqual(['pevt_d', 'pevt_c']);
    expect(page1.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'pevt_c' });

    const second = await target.request(`/api/calendar-events?limit=2&cursor=${page1.pagination.cursor}`, {
      headers: authHeaders(),
    });
    const page2 = (await second.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(page2.data.map((e) => e.id)).toEqual(['pevt_b', 'pevt_a']);
    expect(page2.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });

    // An unknown cursor is ignored.
    const unknown = await target.request('/api/calendar-events?limit=1&cursor=nope', { headers: authHeaders() });
    expect(((await unknown.json()) as { data: Array<{ id: string }> }).data.map((e) => e.id)).toEqual(['pevt_d']);
  });

  it('answers an empty list without calendars, and refuses a bad query', async () => {
    const target = app();
    const none = await target.request('/api/calendar-events?calendarIds=pcal_theirs', { headers: authHeaders() });
    expect(await none.json()).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });

    const bad = await target.request('/api/calendar-events?limit=0', { headers: authHeaders() });
    expect(bad.status).toBe(400);
    const tooMany = await target.request('/api/calendar-events?limit=500', { headers: authHeaders() });
    expect(tooMany.status).toBe(400);

    const notADate = await target.request('/api/calendar-events?startDate=someday', { headers: authHeaders() });
    expect(notADate.status).toBe(500);
    expect(await notADate.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list calendar events' },
    });
  });

  it('reads a range, oldest first', async () => {
    const target = app();
    const res = await target.request(
      '/api/calendar-events/range?startDate=2030-03-04T00:00:00Z&endDate=2030-03-06T23:59:59Z',
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((e) => e.id)).toEqual(['pevt_a', 'pevt_b', 'pevt_c']);

    const narrowed = await target.request(
      '/api/calendar-events/range?startDate=2030-03-01&endDate=2030-03-31&calendarIds=pcal_work',
      { headers: authHeaders() },
    );
    expect(((await narrowed.json()) as { data: Array<{ id: string }> }).data.map((e) => e.id)).toEqual(['pevt_c']);

    const none = await target.request(
      '/api/calendar-events/range?startDate=2030-03-01&endDate=2030-03-31&calendarIds=nope',
      { headers: authHeaders() },
    );
    expect(await none.json()).toEqual({ data: [] });

    const missing = await target.request('/api/calendar-events/range?startDate=2030-03-01', { headers: authHeaders() });
    expect(missing.status).toBe(400);
  });

  it('reads one event, not another person’s', async () => {
    const target = app();
    const res = await target.request('/api/calendar-events/pevt_b', { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { id: 'pevt_b', title: 'Lunch with Sam', description: 'Pizza' } });

    for (const id of ['pevt_theirs', 'pevt_gone']) {
      const missing = await target.request(`/api/calendar-events/${id}`, { headers: authHeaders() });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: { code: 'NOT_FOUND', message: `Calendar event with ID '${id}' not found` },
      });
    }
  });

  it('creates an event in an own calendar', async () => {
    const target = app();
    const res = await target.request('/api/calendar-events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        calendarId: 'pcal_work',
        title: 'Planning',
        startTime: '2030-04-01T10:00:00.000Z',
        endTime: '2030-04-01T11:00:00Z',
        allDay: false,
        timezone: 'Europe/Amsterdam',
        isVirtual: true,
        meetingUrl: 'https://meet.example.com/x',
        priority: 'high',
        attendees: [{ email: 'sam@example.com', name: 'Sam' }],
        reminders: [{ type: 'email', minutes: 15 }],
        tags: ['q2'],
        recurrenceRule: 'FREQ=WEEKLY',
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await personalDb
      .select()
      .from(personalSchema.personalCalendarEvents)
      .where(eq(personalSchema.personalCalendarEvents.id, data.id));
    expect(row).toMatchObject({
      personalAccountId: ACCOUNT,
      calendarId: 'pcal_work',
      type: 'meeting',
      status: 'confirmed',
      priority: 'high',
      organizerId: USER,
      endTime: new Date('2030-04-01T11:00:00.000Z'),
      attendees: [{ email: 'sam@example.com', name: 'Sam' }],
      tags: ['q2'],
      notes: null,
    });

    const minimal = await target.request('/api/calendar-events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ calendarId: 'pcal_home', title: 'Quick', type: 'reminder', startTime: '2030-04-02' }),
    });
    expect(minimal.status).toBe(201);
  });

  it('refuses an event in another person’s calendar, or a bad body', async () => {
    const target = app();
    const theirs = await target.request('/api/calendar-events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ calendarId: 'pcal_theirs', title: 'Sneaky', startTime: '2030-04-01T10:00:00Z' }),
    });
    expect(theirs.status).toBe(403);
    expect(await theirs.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });

    const bad = await target.request('/api/calendar-events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        calendarId: '',
        title: 'x',
        type: 'party',
        startTime: '',
        attendees: [{ email: 'not-an-email' }],
        reminders: [{ type: 'sms', minutes: '5' }],
      }),
    });
    expect(bad.status).toBe(400);
  });

  it('updates, cancels and deletes an event', async () => {
    const target = app();
    const patched = await target.request('/api/calendar-events/pevt_a', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ title: 'Daily standup', startTime: '2030-03-04T09:15:00Z', notes: 'Bring coffee', tags: [] }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({
      data: { id: 'pevt_a', title: 'Daily standup', startTime: '2030-03-04T09:15:00Z', notes: 'Bring coffee', tags: [] },
    });
    const [row] = await personalDb
      .select()
      .from(personalSchema.personalCalendarEvents)
      .where(eq(personalSchema.personalCalendarEvents.id, 'pevt_a'));
    expect(row).toMatchObject({ title: 'Daily standup', startTime: new Date('2030-03-04T09:15:00.000Z'), tags: [] });

    const cancelled = await target.request('/api/calendar-events/pevt_a/cancel', { method: 'PATCH', headers: authHeaders() });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ data: { id: 'pevt_a', status: 'cancelled' } });

    const removed = await target.request('/api/calendar-events/pevt_a', { method: 'DELETE', headers: authHeaders() });
    expect(removed.status).toBe(204);

    for (const [method, path, body] of [
      ['PATCH', '/api/calendar-events/pevt_a', JSON.stringify({ title: 'Again' })],
      ['PATCH', '/api/calendar-events/pevt_theirs/cancel', undefined],
      ['DELETE', '/api/calendar-events/pevt_theirs', undefined],
    ] as const) {
      const res = await target.request(path, { method, headers: authHeaders(), body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    const bad = await target.request('/api/calendar-events/pevt_b', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ priority: 'whenever' }),
    });
    expect(bad.status).toBe(400);
  });
});
