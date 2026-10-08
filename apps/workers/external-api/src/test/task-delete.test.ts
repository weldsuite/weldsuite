/**
 * DELETE /v1/tasks/:id against a real (pglite) Postgres: the task goes with its
 * subtask tree, calendar slots and dependency links, the same as flow-api's
 * DELETE /api/tasks/:id (both run softDeleteTaskTree from
 * @weldsuite/flow-domain/task-tree).
 *
 * The request gets an ENTITY_EVENTS stub and an execution context, so the
 * route's publishEntityEvent calls are captured instead of no-oping.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('DELETE /v1/tasks/:id · subtask tree + dependencies · pglite integration', () => {
  const now = new Date();
  const seedTask = (values: Record<string, unknown>) =>
    db.insert(schema.tasks).values({ title: 'Task', ...values } as typeof schema.tasks.$inferInsert);
  const row = async (id: string) => {
    const [found] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    return found;
  };
  const remove = async (id: string, scopes = ['tasks:write']) => {
    const send = vi.fn((_message: { action: string; entityId: string }) => Promise.resolve());
    const { app, env } = createExternalTestApp({ scopes, tenantDb: db });
    const pending: Promise<unknown>[] = [];
    const res = await app.request(
      `/v1/tasks/${id}`,
      { method: 'DELETE' },
      { ...env, ENTITY_EVENTS: { send } },
      { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} },
    );
    await Promise.all(pending);
    const deletedIds = send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.action === 'deleted')
      .map((message) => message.entityId)
      .sort();
    return { status: res.status, deletedIds };
  };

  it('soft-deletes every subtask level with the parent and publishes deleted for each', async () => {
    await seedTask({ id: 'task_xdel_parent' });
    await seedTask({ id: 'task_xdel_child', parentTaskId: 'task_xdel_parent' });
    await seedTask({ id: 'task_xdel_grandchild', parentTaskId: 'task_xdel_child' });
    await seedTask({ id: 'task_xdel_sibling' });

    const { status, deletedIds } = await remove('task_xdel_parent');
    expect(status).toBe(204);
    expect(deletedIds).toEqual(['task_xdel_child', 'task_xdel_grandchild', 'task_xdel_parent']);

    expect((await row('task_xdel_parent'))?.deletedAt).not.toBeNull();
    expect((await row('task_xdel_child'))?.deletedAt).not.toBeNull();
    expect((await row('task_xdel_grandchild'))?.deletedAt).not.toBeNull();
    expect((await row('task_xdel_sibling'))?.deletedAt).toBeNull();
  });

  it('prunes links to any deleted task, across projects', async () => {
    await seedTask({ id: 'task_xdep_parent', projectId: 'proj_xdel_a', blocks: ['task_xdep_other'] });
    await seedTask({ id: 'task_xdep_child', projectId: 'proj_xdel_a', parentTaskId: 'task_xdep_parent' });
    await seedTask({
      id: 'task_xdep_other',
      projectId: 'proj_xdel_b',
      dependsOn: ['task_xdep_parent', 'task_xdep_keep'],
      blocks: ['task_xdep_child'],
    });
    await seedTask({ id: 'task_xdep_keep', projectId: 'proj_xdel_b' });

    expect((await remove('task_xdep_parent')).status).toBe(204);

    const other = await row('task_xdep_other');
    expect(other?.dependsOn).toEqual(['task_xdep_keep']);
    expect(other?.blocks).toEqual([]);
    expect(other?.deletedAt).toBeNull();
  });

  it('drops the calendar slot of every removed task', async () => {
    await db.insert(schema.calendarEvents).values(
      ['cevt_xdel_parent', 'cevt_xdel_child'].map(
        (id) =>
          ({
            id,
            title: id,
            type: 'reminder',
            startTime: now,
            calendarId: 'cal_xdel_test',
            organizerId: 'user_test',
          }) as typeof schema.calendarEvents.$inferInsert,
      ),
    );
    await seedTask({ id: 'task_xcal_parent', calendarEventId: 'cevt_xdel_parent' });
    await seedTask({ id: 'task_xcal_child', parentTaskId: 'task_xcal_parent', calendarEventId: 'cevt_xdel_child' });

    expect((await remove('task_xcal_parent')).status).toBe(204);

    const slots = await db
      .select({ id: schema.calendarEvents.id, deletedAt: schema.calendarEvents.deletedAt })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.calendarId, 'cal_xdel_test'));
    expect(slots).toHaveLength(2);
    for (const slot of slots) expect(slot.deletedAt).not.toBeNull();
  });

  it('returns 404 for a task that is already deleted', async () => {
    await seedTask({ id: 'task_xdel_twice', deletedAt: now });
    const { status, deletedIds } = await remove('task_xdel_twice');
    expect(status).toBe(404);
    expect(deletedIds).toEqual([]);
  });

  it('still requires the tasks:write scope', async () => {
    await seedTask({ id: 'task_xdel_scoped' });
    expect((await remove('task_xdel_scoped', ['tasks:read'])).status).toBe(403);
    expect((await row('task_xdel_scoped'))?.deletedAt).toBeNull();
  });
});
