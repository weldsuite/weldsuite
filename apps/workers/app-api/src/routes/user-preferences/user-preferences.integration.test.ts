/**
 * /api/user-preferences against a real pglite tenant DB: defaults, the upsert
 * and its `uiPreferences` merge, clearing auto-scheduled task events when an
 * app's auto-scheduling is turned off, the one-field PATCHes and validation.
 * Runs in the Rust conformance suite too (`rust/conformance/suites.json`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { userPreferencesRoutes } from './index';

let db: Database;

const ALICE = 'user_up_alice';
const SCHEDULER = 'user_up_scheduler';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date('2026-01-01T10:00:00.000Z');
  await db.insert(schema.userPreferences).values({
    id: 'upref_up_alice',
    userId: ALICE,
    theme: 'dark',
    fontSize: 14,
    notifications: { email: true },
    uiPreferences: { homeWidgets: { slots: [null, null] }, sidebarCollapsed: true } as never,
    createdAt: now,
    updatedAt: now,
  });

  // The scheduler's auto-placed task events: one WeldFlow task, one WeldCRM
  // task (linked to a company), and one pinned event that must stay.
  await db.insert(schema.tasks).values([
    { id: 'tsk_up_flow', title: 'Flow task', calendarEventId: 'cev_up_flow' },
    { id: 'tsk_up_crm', title: 'CRM task', customerId: 'cus_up_1', calendarEventId: 'cev_up_crm' },
    { id: 'tsk_up_pinned', title: 'Pinned task', calendarEventId: 'cev_up_pinned' },
  ] as (typeof schema.tasks.$inferInsert)[]);
  const event = (id: string, sourceId: string, autoScheduled: boolean) => ({
    id,
    title: id,
    type: 'event',
    startTime: now,
    calendarId: 'cal_up_1',
    organizerId: SCHEDULER,
    sourceType: 'task',
    sourceId,
    autoScheduled,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.calendarEvents).values([
    event('cev_up_flow', 'tsk_up_flow', true),
    event('cev_up_crm', 'tsk_up_crm', true),
    event('cev_up_pinned', 'tsk_up_pinned', false),
  ] as (typeof schema.calendarEvents.$inferInsert)[]);
}, 60_000);

function app(userId: string) {
  return createTestApp('/api/user-preferences', userPreferencesRoutes, { context: { tenantDb: db, userId } });
}

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function eventOf(id: string) {
  const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
  return row;
}

async function taskOf(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return row;
}

describe('GET /api/user-preferences', () => {
  it('returns the stored preferences with defaults filled in', async () => {
    const res = await app(ALICE).request('/api/user-preferences');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      theme: 'dark',
      fontSize: 14,
      language: 'en',
      dateFormat: 'MM/DD/YYYY',
      timeFormat: '12h',
      timezone: 'UTC',
      notifications: { email: true },
      uiPreferences: { homeWidgets: { slots: [null, null] }, sidebarCollapsed: true },
      workingHours: null,
    });
  });

  it('returns the defaults without a row', async () => {
    const res = await app('user_up_nobody').request('/api/user-preferences');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ theme: 'system', fontSize: 16, notifications: {}, uiPreferences: {} });
  });
});

describe('PUT /api/user-preferences', () => {
  it('merges uiPreferences into the stored JSON and sets only what was sent', async () => {
    const res = await app(ALICE).request(
      '/api/user-preferences',
      send('PUT', { language: 'nl', uiPreferences: { compactMode: true }, notifications: { push: false, extra: 1 } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      theme: 'dark',
      fontSize: 14,
      language: 'nl',
      notifications: { push: false },
      uiPreferences: { homeWidgets: { slots: [null, null] }, sidebarCollapsed: true, compactMode: true },
    });
  });

  it('creates the row on a first write (201)', async () => {
    const res = await app('user_up_new').request(
      '/api/user-preferences',
      send('PUT', { theme: 'light', fontSize: 18, workingHours: { monday: { start: '09:00', end: '17:00' } } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      theme: 'light',
      fontSize: 18,
      timezone: 'UTC',
      workingHours: { monday: { start: '09:00', end: '17:00' } },
    });
  });

  it('turning WeldFlow auto-scheduling off clears only the WeldFlow task events', async () => {
    const res = await app(SCHEDULER).request(
      '/api/user-preferences',
      send('PUT', { uiPreferences: { autoScheduleFlowTasks: false } }),
    );
    expect(res.status).toBe(201);
    expect((await eventOf('cev_up_flow'))?.deletedAt).not.toBeNull();
    expect((await taskOf('tsk_up_flow'))?.calendarEventId).toBeNull();
    expect((await eventOf('cev_up_crm'))?.deletedAt).toBeNull();
    expect((await eventOf('cev_up_pinned'))?.deletedAt).toBeNull();
  });

  it('the legacy switch clears every app, and pinned events stay', async () => {
    const res = await app(SCHEDULER).request(
      '/api/user-preferences',
      send('PUT', { uiPreferences: { autoScheduleTasks: false } }),
    );
    expect(res.status).toBe(200);
    expect((await eventOf('cev_up_crm'))?.deletedAt).not.toBeNull();
    expect((await taskOf('tsk_up_crm'))?.calendarEventId).toBeNull();
    expect((await eventOf('cev_up_pinned'))?.deletedAt).toBeNull();
  });

  it.each([
    ['an unknown theme', { theme: 'blue' }],
    ['a font size out of range', { fontSize: 30 }],
    ['a fractional font size', { fontSize: 14.5 }],
    ['uiPreferences that is not an object', { uiPreferences: ['a'] }],
    ['notifications of the wrong type', { notifications: { email: 'yes' } }],
  ])('refuses %s', async (_name, body) => {
    const res = await app(ALICE).request('/api/user-preferences', send('PUT', body));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/user-preferences/theme and /font-size', () => {
  it('updates the theme of an existing row', async () => {
    const res = await app(ALICE).request('/api/user-preferences/theme', send('PATCH', { theme: 'system' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { theme: 'system' } });
  });

  it('creates a row for the theme', async () => {
    const res = await app('user_up_theme').request('/api/user-preferences/theme', send('PATCH', { theme: 'dark' }));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, 'user_up_theme'));
    expect(row?.theme).toBe('dark');
    expect(row?.fontSize).toBe(16);
  });

  it('updates and creates the font size', async () => {
    const existing = await app(ALICE).request('/api/user-preferences/font-size', send('PATCH', { fontSize: 20 }));
    expect(existing.status).toBe(200);
    expect(await existing.json()).toEqual({ data: { fontSize: 20 } });
    const created = await app('user_up_font').request('/api/user-preferences/font-size', send('PATCH', { fontSize: 12 }));
    expect(created.status).toBe(200);
  });

  it('refuses a bad theme or font size', async () => {
    const theme = await app(ALICE).request('/api/user-preferences/theme', send('PATCH', {}));
    expect(theme.status).toBe(400);
    const size = await app(ALICE).request('/api/user-preferences/font-size', send('PATCH', { fontSize: 11 }));
    expect(size.status).toBe(400);
  });
});
