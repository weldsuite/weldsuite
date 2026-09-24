/**
 * Calendar replan index: the due-time query against a real tenant schema
 * (pglite), and the request glue that refreshes the D1 row after writes.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from './id';
import {
  calendarReplanIndexMiddleware,
  computeCalendarReplanDueAt,
  trackCalendarWrite,
} from './calendar-replan-index';
import type { Env, Variables } from '../types';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.calendarEvents);
  await db.delete(schema.tasks);
});

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 9, 0, 0));

async function seedTaskEvent(opts: {
  start: Date;
  taskStatus?: string;
  taskDeleted?: boolean;
  autoScheduled?: boolean;
  eventStatus?: string;
  eventDeleted?: boolean;
}): Promise<void> {
  const taskId = generateId('tsk');
  await db.insert(schema.tasks).values({
    id: taskId,
    title: 'Write report',
    status: opts.taskStatus ?? 'todo',
    deletedAt: opts.taskDeleted ? new Date() : null,
  });
  await db.insert(schema.calendarEvents).values({
    id: generateId('evt'),
    title: 'Write report',
    type: 'event',
    startTime: opts.start,
    endTime: new Date(opts.start.getTime() + 30 * 60_000),
    calendarId: 'cal_test',
    organizerId: 'user_test',
    status: opts.eventStatus ?? 'confirmed',
    sourceType: 'task',
    sourceId: taskId,
    autoScheduled: opts.autoScheduled ?? true,
    deletedAt: opts.eventDeleted ? new Date() : null,
  });
}

describe('computeCalendarReplanDueAt', () => {
  it('is null when no auto-scheduled event exists', async () => {
    expect(await computeCalendarReplanDueAt(db)).toBeNull();
  });

  it('returns the earliest start among events the replan would pick up', async () => {
    await seedTaskEvent({ start: day(5) });
    await seedTaskEvent({ start: day(3) });
    await seedTaskEvent({ start: day(9) });
    expect((await computeCalendarReplanDueAt(db))?.toISOString()).toBe(day(3).toISOString());
  });

  it('ignores events the replan skips', async () => {
    await seedTaskEvent({ start: day(1), autoScheduled: false }); // pinned by the user
    await seedTaskEvent({ start: day(1), eventStatus: 'cancelled' });
    await seedTaskEvent({ start: day(1), eventDeleted: true });
    await seedTaskEvent({ start: day(1), taskStatus: 'done' });
    await seedTaskEvent({ start: day(1), taskStatus: 'cancelled' });
    await seedTaskEvent({ start: day(1), taskDeleted: true });
    expect(await computeCalendarReplanDueAt(db)).toBeNull();

    await seedTaskEvent({ start: day(7) });
    expect((await computeCalendarReplanDueAt(db))?.toISOString()).toBe(day(7).toISOString());
  });
});

describe('calendarReplanIndexMiddleware', () => {
  function fakeD1() {
    const writes: { sql: string; args: unknown[] }[] = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            writes.push({ sql, args });
            return { success: true };
          },
        }),
      }),
    };
    return { d1: d1 as unknown as D1Database, writes };
  }

  function makeApp(everyWrite = false) {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('tenantDb', db);
      c.set('workspaceId', 'org_cal');
      await next();
    });
    app.use('*', calendarReplanIndexMiddleware({ everyWrite }));
    return app;
  }

  async function call(app: Hono<{ Bindings: Env; Variables: Variables }>, method: string, path: string) {
    const { d1, writes } = fakeD1();
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const res = await app.request(path, { method }, { SCHEDULE_INDEX: d1 }, executionCtx);
    // Drain background work, including anything queued while draining.
    for (let i = 0; i < pending.length; i++) await pending[i];
    return { res, writes };
  }

  it('re-indexes only after the tracked background write has landed', async () => {
    const app = makeApp();
    app.post('/tasks', (c) => {
      const work = new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() =>
        seedTaskEvent({ start: day(4) }),
      );
      trackCalendarWrite(c, work);
      return c.json({ ok: true });
    });

    const { res, writes } = await call(app, 'POST', '/tasks');
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain('INSERT INTO calendar_replan_index');
    expect(writes[0]!.args.slice(0, 2)).toEqual(['org_cal', day(4).getTime()]);
  });

  it('clears the row when nothing is left to replan', async () => {
    const app = makeApp();
    app.delete('/tasks/1', (c) => {
      trackCalendarWrite(c);
      return c.body(null, 204);
    });
    const { writes } = await call(app, 'DELETE', '/tasks/1');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toContain('DELETE FROM calendar_replan_index');
  });

  it('leaves the index alone for writes that did not touch the calendar', async () => {
    const app = makeApp();
    app.post('/tasks/1/comments', (c) => c.json({ ok: true }, 201));
    const { writes } = await call(app, 'POST', '/tasks/1/comments');
    expect(writes).toHaveLength(0);
  });

  it('leaves the index alone when the request failed', async () => {
    const app = makeApp();
    app.patch('/tasks/1', (c) => {
      trackCalendarWrite(c);
      return c.json({ error: 'nope' }, 400);
    });
    const { writes } = await call(app, 'PATCH', '/tasks/1');
    expect(writes).toHaveLength(0);
  });

  it('with everyWrite, re-indexes after any successful write but not reads', async () => {
    const app = makeApp(true);
    app.patch('/events/1', (c) => c.json({ ok: true }));
    app.get('/events', (c) => c.json({ data: [] }));
    expect((await call(app, 'PATCH', '/events/1')).writes).toHaveLength(1);
    expect((await call(app, 'GET', '/events')).writes).toHaveLength(0);
  });

  it('never fails the request when D1 is down', async () => {
    const app = makeApp(true);
    app.patch('/events/1', (c) => c.json({ ok: true }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      prepare: () => ({ bind: () => ({ run: async () => Promise.reject(new Error('D1 down')) }) }),
    } as unknown as D1Database;
    const pending: Promise<unknown>[] = [];
    const res = await app.request('/events/1', { method: 'PATCH' }, { SCHEDULE_INDEX: broken }, {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext);
    await Promise.all(pending);
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
