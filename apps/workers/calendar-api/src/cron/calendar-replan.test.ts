/**
 * Nightly re-plan on the D1 due index: the sweep opens only workspaces whose
 * auto-scheduled events are due, re-plans them, and stores when the next one
 * will need it (`nextAutoScheduledReplanAt`). Tenant: pglite. Index: SQLite.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { listDueWorkspaces, markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { nextAutoScheduledReplanAt } from '@weldsuite/db/lib/calendar-sync';

let db: Database;
let close: () => Promise<void>;
const tenantDbFor = vi.fn(async (_env: unknown, _orgId: string) => db);
const activeWorkspaces = vi.fn(async () => [{ clerkOrgId: 'org_tenant' }]);

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: (env: unknown, orgId: string) => tenantDbFor(env, orgId),
    getMasterDb: () => ({ select: () => ({ from: () => ({ where: () => activeWorkspaces() }) }) }),
  };
});

import { runCalendarReplanSweep, CALENDAR_REPLAN_SEED_KEY } from './calendar-replan';

const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

const HOUR = 3_600_000;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
}, 60_000);

afterAll(async () => {
  if (close) await close();
});

beforeEach(async () => {
  await db.delete(schema.calendarEvents);
  await db.delete(schema.tasks);
  await db.delete(schema.userPreferences);
  tenantDbFor.mockClear();
  activeWorkspaces.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

let seq = 0;
async function seedTaskEvent(opts: { start: Date; status?: string; autoScheduled?: boolean; organizerId?: string }) {
  seq += 1;
  const taskId = `task_dueidx_${seq}`;
  const eventId = `cev_dueidx_${seq}`;
  await db.insert(schema.tasks).values({
    id: taskId,
    title: `Task ${seq}`,
    status: opts.status ?? 'todo',
    priority: 'medium',
    calendarEventId: eventId,
  } as typeof schema.tasks.$inferInsert);
  await db.insert(schema.calendarEvents).values({
    id: eventId,
    title: `Task ${seq}`,
    type: 'task',
    startTime: opts.start,
    endTime: new Date(opts.start.getTime() + 30 * 60_000),
    status: 'confirmed',
    calendarId: `cal_dueidx_${seq}`,
    organizerId: opts.organizerId ?? 'user_dueidx',
    sourceType: 'task',
    sourceId: taskId,
    autoScheduled: opts.autoScheduled ?? true,
  } as typeof schema.calendarEvents.$inferInsert);
  return { taskId, eventId };
}

function makeEnv(seeded: boolean) {
  const kv = createMemoryKv();
  if (seeded) kv.store.set(CALENDAR_REPLAN_SEED_KEY, 'done');
  return { SCHEDULE_INDEX: createSqliteD1(MIGRATION), WORKSPACE_CACHE: kv };
}

describe('nextAutoScheduledReplanAt', () => {
  it('is null without auto-scheduled events', async () => {
    await seedTaskEvent({ start: new Date(Date.now() + HOUR), autoScheduled: false });
    expect(await nextAutoScheduledReplanAt(db)).toBeNull();
  });

  it('is the earliest start among events the re-plan would move', async () => {
    const soon = new Date(Date.now() + 2 * HOUR);
    await seedTaskEvent({ start: new Date(Date.now() + 9 * HOUR) });
    await seedTaskEvent({ start: soon });
    expect((await nextAutoScheduledReplanAt(db))?.getTime()).toBe(soon.getTime());
  });

  it('ignores finished tasks and users who opted out of re-planning', async () => {
    await seedTaskEvent({ start: new Date(Date.now() - HOUR), status: 'done' });
    await seedTaskEvent({ start: new Date(Date.now() - HOUR), organizerId: 'user_optout' });
    await db.insert(schema.userPreferences).values({
      id: 'upref_dueidx_optout',
      userId: 'user_optout',
      uiPreferences: { autoRescheduleTasks: false },
    } as typeof schema.userPreferences.$inferInsert);
    expect(await nextAutoScheduledReplanAt(db)).toBeNull();
  });
});

describe('runCalendarReplanSweep', () => {
  it('opens no tenant when nothing is due', async () => {
    const env = makeEnv(true);
    const res = await runCalendarReplanSweep(env as never);
    expect(res.workspacesScanned).toBe(0);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('seeds once, re-plans a stale event and waits for its new start', async () => {
    await seedTaskEvent({ start: new Date(Date.now() - 24 * HOUR) });
    const env = makeEnv(false);

    const res = await runCalendarReplanSweep(env as never);
    expect(activeWorkspaces).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ workspacesScanned: 1, totalScanned: 1, totalRescheduled: 1 });

    // The row now sits at the re-planned event's start, in the future.
    const nextStart = await nextAutoScheduledReplanAt(db);
    expect(nextStart!.getTime()).toBeGreaterThan(Date.now());
    expect(await listDueWorkspaces(env.SCHEDULE_INDEX, 'calendar_replan', Date.now(), 10)).toEqual([]);
    expect(
      (await listDueWorkspaces(env.SCHEDULE_INDEX, 'calendar_replan', nextStart!.getTime(), 10))[0]?.nextDueAt,
    ).toBe(nextStart!.getTime());
  });

  it('drops a due workspace that has nothing left to re-plan', async () => {
    const env = makeEnv(true);
    await markWorkspaceDue(env.SCHEDULE_INDEX, 'calendar_replan', 'org_tenant', Date.now() - 1);

    await runCalendarReplanSweep(env as never);
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    const remaining = await env.SCHEDULE_INDEX.prepare('SELECT COUNT(*) AS n FROM workspace_due_index').first<number>('n');
    expect(remaining).toBe(0);
  });
});
