/**
 * DB-backed integration tests for the time-entry guards (TASK-768, TASK-786):
 *
 *   - approve / reject need project-manager rights and never apply to your own entry,
 *   - approved entries are locked until a manager rejects them,
 *   - hours can only be logged against a project / task the caller can write to,
 *   - stopping a timer writes exactly one entry, dated in the caller's time zone.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { calendarDate, timeEntriesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

const PROJECT = 'prj_te_guard';
const OTHER_PROJECT = 'prj_te_other';
const MANAGER = 'user_te_manager';
const MEMBER = 'user_te_member';
const VIEWER = 'user_te_viewer';
const OUTSIDER = 'user_te_outsider';

let db: Database;

function as(userId: string, ...extra: string[]) {
  return createTestApp('/api/time-entries', timeEntriesRoutes, {
    context: {
      userId,
      permissions: permissions('time:read', 'time:create', 'time:update', 'time:delete', ...extra),
      tenantDb: db,
    },
  }).request;
}

type Send = ReturnType<typeof as>;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function seedProject(id: string, managerId: string) {
  const now = new Date();
  await db
    .insert(schema.projects)
    .values({ id, name: `Project ${id}`, projectManagerId: managerId, createdAt: now, updatedAt: now } as typeof schema.projects.$inferInsert)
    .onConflictDoNothing();
}

async function seedMember(projectId: string, userId: string, role: string) {
  const now = new Date();
  await db
    .insert(schema.projectMembers)
    .values({
      id: `pm_${projectId}_${userId}`,
      projectId,
      userId,
      role,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      joinedAt: now,
    } as typeof schema.projectMembers.$inferInsert)
    .onConflictDoNothing();
}

async function seedTask(id: string, projectId: string | null) {
  const now = new Date();
  await db
    .insert(schema.tasks)
    .values({ id, title: `Task ${id}`, projectId, createdAt: now, updatedAt: now } as typeof schema.tasks.$inferInsert)
    .onConflictDoNothing();
}

async function seedEntry(id: string, userId: string, overrides: Record<string, unknown> = {}) {
  const now = new Date();
  await db
    .insert(schema.timeEntries)
    .values({
      id,
      userId,
      date: '2026-06-01',
      duration: '60',
      billable: true,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as typeof schema.timeEntries.$inferInsert)
    .onConflictDoNothing();
}

async function entryRow(id: string) {
  const [row] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, id)).limit(1);
  return row;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  await seedProject(PROJECT, MANAGER);
  await seedProject(OTHER_PROJECT, 'someone_else');
  await seedMember(PROJECT, MEMBER, 'member');
  await seedMember(PROJECT, VIEWER, 'viewer');
  await seedTask('task_te_in_project', PROJECT);
  await seedTask('task_te_in_other', OTHER_PROJECT);
  await seedTask('task_te_personal', null);
}, 60_000);

beforeEach(() => {
  vi.mocked(publishEntityEvent).mockClear();
});

describe('approve / reject', () => {
  async function approve(send: Send, id: string) {
    return send(`/api/time-entries/${id}/approve`, json('PATCH'));
  }

  it('lets the project manager approve a member entry and publishes the timesheet event', async () => {
    await seedEntry('time_g_ok', MEMBER, { projectId: PROJECT });
    const res = await approve(as(MANAGER), 'time_g_ok');

    expect(res.status).toBe(200);
    const row = await entryRow('time_g_ok');
    expect(row?.status).toBe('approved');
    expect(row?.approvedBy).toBe(MANAGER);

    const calls = vi.mocked(publishEntityEvent).mock.calls.map(([arg]) => arg);
    expect(calls).toContainEqual(
      expect.objectContaining({ entityType: 'project_timesheet', action: 'approved', entityId: 'time_g_ok' }),
    );
  });

  it('refuses a plain member, the entry author and an outsider', async () => {
    await seedEntry('time_g_no', 'user_te_author', { projectId: PROJECT });

    expect((await approve(as(MEMBER), 'time_g_no')).status).toBe(403);
    expect((await approve(as(OUTSIDER), 'time_g_no')).status).toBe(403);
    expect((await row('time_g_no')).status).toBe('draft');

    // Even a manager cannot sign off hours they logged themselves.
    await seedEntry('time_g_self', MANAGER, { projectId: PROJECT });
    expect((await approve(as(MANAGER), 'time_g_self')).status).toBe(403);
    expect((await as(MANAGER)('/api/time-entries/time_g_self/reject', json('PATCH'))).status).toBe(403);
    expect((await row('time_g_self')).status).toBe('draft');
  });

  it('only lets a projects:scope:all holder review an entry without a project', async () => {
    await seedEntry('time_g_nopr', MEMBER);
    expect((await approve(as(MANAGER), 'time_g_nopr')).status).toBe(403);
    expect((await approve(as('user_te_admin', 'projects:scope:all'), 'time_g_nopr')).status).toBe(200);
  });

  it('publishes the rejected event and clears the approval', async () => {
    await seedEntry('time_g_rej', MEMBER, { projectId: PROJECT });
    await approve(as(MANAGER), 'time_g_rej');
    vi.mocked(publishEntityEvent).mockClear();

    const res = await as(MANAGER)('/api/time-entries/time_g_rej/reject', json('PATCH'));
    expect(res.status).toBe(200);
    const stored = await entryRow('time_g_rej');
    expect(stored?.status).toBe('rejected');
    expect(stored?.approvedBy).toBeNull();
    expect(vi.mocked(publishEntityEvent).mock.calls.map(([arg]) => arg)).toContainEqual(
      expect.objectContaining({ entityType: 'project_timesheet', action: 'rejected' }),
    );
  });

  async function row(id: string) {
    const r = await entryRow(id);
    if (!r) throw new Error(`missing ${id}`);
    return r;
  }
});

describe('approved entries are locked', () => {
  it('answers 409 to PATCH and DELETE by the owner until a manager rejects it', async () => {
    await seedEntry('time_g_lock', MEMBER, { projectId: PROJECT });
    await as(MANAGER)('/api/time-entries/time_g_lock/approve', json('PATCH'));

    const owner = as(MEMBER);
    expect((await owner('/api/time-entries/time_g_lock', json('PATCH', { duration: 120 }))).status).toBe(409);
    expect((await owner('/api/time-entries/time_g_lock', { method: 'DELETE' })).status).toBe(409);
    expect(Number((await entryRow('time_g_lock'))?.duration)).toBe(60);

    await as(MANAGER)('/api/time-entries/time_g_lock/reject', json('PATCH'));
    expect((await owner('/api/time-entries/time_g_lock', json('PATCH', { duration: 120 }))).status).toBe(200);
  });
});

describe('logging against a project or task', () => {
  const body = (extra: Record<string, unknown>) => ({ date: '2026-06-02', duration: 30, ...extra });
  const create = (send: Send, extra: Record<string, unknown>) =>
    send('/api/time-entries', json('POST', body(extra)));

  it('requires write access to the project', async () => {
    expect((await create(as(MEMBER), { projectId: PROJECT })).status).toBe(201);
    expect((await create(as(VIEWER), { projectId: PROJECT })).status).toBe(403);
    expect((await create(as(OUTSIDER), { projectId: PROJECT })).status).toBe(403);
    expect((await create(as(MEMBER), { projectId: OTHER_PROJECT })).status).toBe(403);
  });

  it('checks the task and adopts its project', async () => {
    const res = await create(as(MEMBER), { taskId: 'task_te_in_project' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect((await entryRow(data.id))?.projectId).toBe(PROJECT);

    expect((await create(as(MEMBER), { taskId: 'task_te_in_other' })).status).toBe(403);
    expect((await create(as(MEMBER), { taskId: 'task_te_missing' })).status).toBe(404);
    expect((await create(as(MEMBER), { projectId: PROJECT, taskId: 'task_te_in_other' })).status).toBe(400);
  });

  it('still allows hours without a project', async () => {
    expect((await create(as(OUTSIDER), {})).status).toBe(201);
    expect((await create(as(OUTSIDER), { taskId: 'task_te_personal' })).status).toBe(201);
  });

  it('checks access again when an entry is moved to another project', async () => {
    const created = await create(as(MEMBER), { projectId: PROJECT, date: '2026-06-03' });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await as(MEMBER)(`/api/time-entries/${data.id}`, json('PATCH', { projectId: OTHER_PROJECT }));
    expect(res.status).toBe(403);
    expect((await entryRow(data.id))?.projectId).toBe(PROJECT);
  });

  it('checks access when a timer starts', async () => {
    expect((await as(OUTSIDER)('/api/time-entries/timer/start', json('POST', { projectId: PROJECT }))).status).toBe(403);
  });
});

describe('POST /timer/stop', () => {
  async function startTimerAt(userId: string, startedAt: Date, extra: Record<string, unknown> = {}) {
    const res = await as(userId)('/api/time-entries/timer/start', json('POST', extra));
    expect(res.status).toBe(201);
    await db.update(schema.activeTimers).set({ startedAt }).where(eq(schema.activeTimers.userId, userId));
  }

  async function entriesOf(userId: string) {
    return db.select().from(schema.timeEntries).where(eq(schema.timeEntries.userId, userId));
  }

  it('writes one entry when the stop is sent twice at once', async () => {
    const user = 'user_te_double';
    await startTimerAt(user, new Date(Date.now() - 10 * 60_000));
    const stop = () => as(user)('/api/time-entries/timer/stop', json('POST', {}));

    const results = await Promise.all([stop(), stop()]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    expect(await entriesOf(user)).toHaveLength(1);
    const left = await db.select().from(schema.activeTimers).where(eq(schema.activeTimers.userId, user));
    expect(left).toHaveLength(0);
  });

  it('dates the entry in the caller time zone, not UTC', async () => {
    const user = 'user_te_tz';
    // 23:30 UTC on the 15th is already 01:30 on the 16th in Amsterdam (CEST).
    const startedAt = new Date('2026-10-15T23:30:00Z');
    await startTimerAt(user, startedAt);

    const res = await as(user)('/api/time-entries/timer/stop', json('POST', { timeZone: 'Europe/Amsterdam' }));
    expect(res.status).toBe(201);
    expect((await entriesOf(user))[0]?.date).toBe('2026-10-16');
  });

  it('falls back to the UTC date without a time zone and rejects an unknown one', async () => {
    const user = 'user_te_utc';
    await startTimerAt(user, new Date('2026-10-15T23:30:00Z'));

    expect((await as(user)('/api/time-entries/timer/stop', json('POST', { timeZone: 'Mars/Olympus' }))).status).toBe(400);
    expect((await as(user)('/api/time-entries/timer/stop', json('POST', {}))).status).toBe(201);
    expect((await entriesOf(user))[0]?.date).toBe('2026-10-15');
  });
});

describe('GET /?billable=', () => {
  it('reads "false" as false, not as true', async () => {
    const user = 'user_te_billable';
    await seedEntry('time_g_bill_yes', user, { billable: true });
    await seedEntry('time_g_bill_no', user, { billable: false });
    const list = async (query: string) => {
      const res = await as(user)(`/api/time-entries?${query}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { id: string }[] }).data.map((e) => e.id);
    };

    expect(await list('billable=false')).toEqual(['time_g_bill_no']);
    expect(await list('billable=true')).toEqual(['time_g_bill_yes']);
    expect((await list('')).sort()).toEqual(['time_g_bill_no', 'time_g_bill_yes']);
  });
});

describe('calendarDate', () => {
  it('returns the day an instant falls on in a zone', () => {
    const instant = new Date('2026-10-15T23:30:00Z');
    expect(calendarDate(instant)).toBe('2026-10-15');
    expect(calendarDate(instant, 'Europe/Amsterdam')).toBe('2026-10-16');
    expect(calendarDate(instant, 'America/Los_Angeles')).toBe('2026-10-15');
  });
});
