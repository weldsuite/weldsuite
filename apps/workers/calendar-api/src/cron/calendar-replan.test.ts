/**
 * Nightly re-plan on the D1 due index: the sweep opens only workspaces whose
 * auto-scheduled events are due, re-plans them, and stores when the next one
 * will need it (`nextAutoScheduledReplanAt`). Tenant and master: pglite.
 * Index: SQLite.
 *
 * In conformance mode the sweep runs on the Rust server too
 * (`weldsuite cron calendar-replan`), through `conformanceSweep`: result and
 * due index must match, and the assertions check Rust's run.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { conformanceSweep } from '@weldsuite/worker-kit/testing/conformance-cron';
import { eq, sql } from 'drizzle-orm';
import {
  createCalendarEventForTask,
  nextAutoScheduledReplanAt,
  removeAutoScheduledTaskEvents,
} from '@weldsuite/db/lib/calendar-sync';

let db: Database;
let master: MasterDatabase;
let close: () => Promise<void>;
/** The tenant database the sweep opens (a copy of `db` while TypeScript runs in conformance mode). */
const dbs = vi.hoisted(() => ({ tenant: null as unknown, master: null as unknown }));
const tenantDbFor = vi.fn(async (_env: unknown, _orgId: string) => dbs.tenant);

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: (env: unknown, orgId: string) => tenantDbFor(env, orgId),
    getMasterDb: () => dbs.master,
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
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
  // The one active workspace the seed finds.
  await master.insert(masterSchema.workspaces).values({
    id: 'ws_tenant',
    name: 'Tenant',
    slug: 'tenant',
    clerkOrgId: 'org_tenant',
  } as typeof masterSchema.workspaces.$inferInsert);
}, 120_000);

afterAll(async () => {
  if (close) await close();
});

beforeEach(async () => {
  await db.delete(schema.calendarEvents);
  await db.delete(schema.tasks);
  await db.delete(schema.userPreferences);
  tenantDbFor.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

let seq = 0;
async function seedTaskEvent(opts: {
  start: Date;
  status?: string;
  autoScheduled?: boolean;
  organizerId?: string;
  /** A WeldCRM task (linked to a company) instead of a WeldFlow one. */
  crm?: boolean;
}) {
  seq += 1;
  const taskId = `task_dueidx_${seq}`;
  const eventId = `cev_dueidx_${seq}`;
  await db.insert(schema.tasks).values({
    id: taskId,
    title: `Task ${seq}`,
    status: opts.status ?? 'todo',
    priority: 'medium',
    calendarEventId: eventId,
    customerId: opts.crm ? 'cust_dueidx' : null,
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

/** `runCalendarReplanSweep(env)`, on both backends in conformance mode. */
function sweep(env: ReturnType<typeof makeEnv>) {
  return conformanceSweep({
    job: 'calendar-replan',
    now: new Date(),
    tenantDb: db,
    masterDb: master as unknown as Database,
    env: env as unknown as Record<string, unknown>,
    dueIndex: { d1: env.SCHEDULE_INDEX as never, kind: 'calendar_replan' },
    kv: env.WORKSPACE_CACHE as object,
    workspaces: { ws_tenant: 'org_tenant' },
    runTypeScript: async (tenantDb) => {
      dbs.tenant = tenantDb;
      try {
        return await runCalendarReplanSweep(env as never);
      } finally {
        dbs.tenant = db;
      }
    },
    // The re-plan publishes no entity events.
    takeTypeScriptEvents: () => [],
  });
}

/** Mark the workspace due in the test's D1 index and, for Rust, in the master one. */
async function markDue(env: ReturnType<typeof makeEnv>, at: number) {
  await markWorkspaceDue(env.SCHEDULE_INDEX, 'calendar_replan', 'org_tenant', at);
  if (conformanceTarget()) {
    await master.execute(sql`
      insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version)
      values ('calendar_replan', 'ws_tenant', ${new Date(at).toISOString()}::timestamptz, now(), 1)`);
  }
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

  it('ignores users who turned off task auto-scheduling', async () => {
    await seedTaskEvent({ start: new Date(Date.now() - HOUR), organizerId: 'user_noauto' });
    await optOutOfAutoSchedule('user_noauto');
    expect(await nextAutoScheduledReplanAt(db)).toBeNull();
  });

  it("ignores only the tasks of the app whose auto-scheduling is off", async () => {
    const crmStart = new Date(Date.now() - 2 * HOUR);
    await seedTaskEvent({ start: crmStart, organizerId: 'user_noflow', crm: true });
    await seedTaskEvent({ start: new Date(Date.now() - HOUR), organizerId: 'user_noflow' });
    await optOutOfAutoSchedule('user_noflow', { autoScheduleFlowTasks: false });
    expect((await nextAutoScheduledReplanAt(db))?.getTime()).toBe(crmStart.getTime());
  });
});

async function optOutOfAutoSchedule(
  userId: string,
  uiPreferences: Record<string, boolean> = { autoScheduleTasks: false },
) {
  await db.insert(schema.userPreferences).values({
    id: `upref_${userId}`,
    userId,
    uiPreferences,
  } as typeof schema.userPreferences.$inferInsert);
}

describe('auto-scheduling switched per app', () => {
  async function createTask(id: string, crm: boolean) {
    await db.insert(schema.tasks).values({
      id,
      title: id,
      status: 'todo',
      priority: 'medium',
      personId: crm ? 'per_split' : null,
    } as typeof schema.tasks.$inferInsert);
    return createCalendarEventForTask(db, {
      userId: 'user_split',
      taskId: id,
      title: id,
      dueDate: new Date(Date.now() + 48 * HOUR),
    });
  }

  it('places WeldFlow tasks but not WeldCRM tasks when only CRM is off', async () => {
    await optOutOfAutoSchedule('user_split', { autoScheduleCrmTasks: false });
    expect(await createTask('task_split_crm', true)).toBeNull();
    expect(await createTask('task_split_flow', false)).not.toBeNull();
  });

  it("an app's own switch overrides the legacy shared one", async () => {
    await optOutOfAutoSchedule('user_split', { autoScheduleTasks: false, autoScheduleFlowTasks: true });
    expect(await createTask('task_split_flow', false)).not.toBeNull();
    expect(await createTask('task_split_crm', true)).toBeNull();
  });

  it('removeAutoScheduledTaskEvents clears only the given app', async () => {
    const crm = await seedTaskEvent({ start: new Date(Date.now() + HOUR), organizerId: 'user_split', crm: true });
    const flow = await seedTaskEvent({ start: new Date(Date.now() + HOUR), organizerId: 'user_split' });

    expect(await removeAutoScheduledTaskEvents(db, 'user_split', 'crm')).toBe(1);
    const events = await db.select().from(schema.calendarEvents);
    const deleted = events.filter((e) => e.deletedAt).map((e) => e.id);
    expect(deleted).toEqual([crm.eventId]);

    expect(await removeAutoScheduledTaskEvents(db, 'user_split', 'flow')).toBe(1);
    const [flowEvent] = await db
      .select()
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, flow.eventId));
    expect(flowEvent.deletedAt).not.toBeNull();
  });
});

describe('task auto-scheduling turned off', () => {
  it('places no event for a task without a start date', async () => {
    await optOutOfAutoSchedule('user_noauto');
    const eventId = await createCalendarEventForTask(db, {
      userId: 'user_noauto',
      taskId: 'task_noauto',
      title: 'Write report',
      dueDate: new Date(Date.now() + 48 * HOUR),
    });
    expect(eventId).toBeNull();
    expect(await db.select().from(schema.calendarEvents)).toHaveLength(0);
  });

  it('still auto-places events of other sources', async () => {
    await optOutOfAutoSchedule('user_noauto');
    const eventId = await createCalendarEventForTask(db, {
      userId: 'user_noauto',
      sourceId: 'act_noauto',
      sourceType: 'activity',
      title: 'Follow-up call',
      dueDate: new Date(Date.now() + 48 * HOUR),
    });
    expect(eventId).not.toBeNull();
  });

  it('still pins a task that has a start date', async () => {
    await optOutOfAutoSchedule('user_noauto');
    const start = new Date(Date.now() + 24 * HOUR);
    const eventId = await createCalendarEventForTask(db, {
      userId: 'user_noauto',
      taskId: 'task_pinned',
      title: 'Client call prep',
      startDate: start,
    });
    const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId!));
    expect(row).toMatchObject({ autoScheduled: false });
    expect(row.startTime.getTime()).toBe(start.getTime());
  });

  it('removeAutoScheduledTaskEvents clears auto-placed events only', async () => {
    const auto = await seedTaskEvent({ start: new Date(Date.now() + HOUR), organizerId: 'user_noauto' });
    const pinned = await seedTaskEvent({
      start: new Date(Date.now() + HOUR),
      organizerId: 'user_noauto',
      autoScheduled: false,
    });
    const otherUser = await seedTaskEvent({ start: new Date(Date.now() + HOUR), organizerId: 'user_other' });

    expect(await removeAutoScheduledTaskEvents(db, 'user_noauto')).toBe(1);
    expect(await removeAutoScheduledTaskEvents(db, 'user_noauto')).toBe(0);

    const events = await db.select().from(schema.calendarEvents);
    const deleted = new Set(events.filter((e) => e.deletedAt).map((e) => e.id));
    expect([...deleted]).toEqual([auto.eventId]);

    const tasks = await db.select().from(schema.tasks);
    const linked = Object.fromEntries(tasks.map((task) => [task.id, task.calendarEventId]));
    expect(linked[auto.taskId]).toBeNull();
    expect(linked[pinned.taskId]).toBe(pinned.eventId);
    expect(linked[otherUser.taskId]).toBe(otherUser.eventId);
  });
});

describe('runCalendarReplanSweep', () => {
  it('opens no tenant when nothing is due', async () => {
    const env = makeEnv(true);
    const res = await sweep(env);
    expect(res.workspacesScanned).toBe(0);
    expect(tenantDbFor).not.toHaveBeenCalled();
  });

  it('seeds once, re-plans a stale event and waits for its new start', async () => {
    const staleStart = new Date(Date.now() - 24 * HOUR);
    await seedTaskEvent({ start: staleStart });
    const env = makeEnv(false);

    const res = await sweep(env);
    expect(res).toMatchObject({ workspacesScanned: 1, totalScanned: 1, totalRescheduled: 1 });

    // The event moved forward, and the row now sits at its new start. (The
    // scheduler may place it in the slot that is already under way, so the
    // start can be a little in the past — the next nightly run then re-plans it.)
    const nextStart = await nextAutoScheduledReplanAt(db);
    expect(nextStart!.getTime()).toBeGreaterThan(staleStart.getTime());
    const row = await env.SCHEDULE_INDEX
      .prepare("SELECT next_due_at FROM workspace_due_index WHERE kind = 'calendar_replan' AND workspace_id = ?")
      .bind('org_tenant')
      .first<number>('next_due_at');
    expect(row).toBe(nextStart!.getTime());
  });

  it('drops a due workspace that has nothing left to re-plan', async () => {
    const env = makeEnv(true);
    // A first, empty tick: the harness starts both indexes empty.
    await sweep(env);
    await markDue(env, Date.now() - 1);

    await sweep(env);
    expect(tenantDbFor).toHaveBeenCalledTimes(1);
    const remaining = await env.SCHEDULE_INDEX.prepare('SELECT COUNT(*) AS n FROM workspace_due_index').first<number>('n');
    expect(remaining).toBe(0);
  });
});
