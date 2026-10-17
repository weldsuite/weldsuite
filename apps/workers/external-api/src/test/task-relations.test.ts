/**
 * POST / PATCH /v1/tasks write guards against a real (pglite) Postgres.
 *
 * Create inserts named columns only (a client cannot set server-owned columns),
 * and `projectId` / `parentTaskId` / `dependsOn` / `blocks` run the same checks
 * as flow-api: no project change through PATCH, parent in the same project and
 * not a descendant, existing linked tasks, no cycles, reciprocal link sync.
 * The mcp-server's copy of this route is identical.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { linkCreatedTask } from '@weldsuite/flow-domain/task-dependencies';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.projects).values([
    { id: 'proj_xrel_a', name: 'A', createdAt: now, updatedAt: now },
    { id: 'proj_xrel_b', name: 'B', createdAt: now, updatedAt: now },
  ] as (typeof schema.projects.$inferInsert)[]);
}, 60_000);

describe('/v1/tasks relation guards · pglite integration', () => {
  const seedTask = (values: Record<string, unknown>) =>
    db.insert(schema.tasks).values({ title: 'Task', ...values } as typeof schema.tasks.$inferInsert);
  const row = async (id: string) => {
    const [found] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    return found;
  };
  const send = (method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>) => {
    const { app, env } = createExternalTestApp({ scopes: ['tasks:read', 'tasks:write'], tenantDb: db });
    return app.request(
      path,
      { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} },
    );
  };
  const post = (body: Record<string, unknown>) => send('POST', '/v1/tasks', body);
  const patch = (id: string, body: Record<string, unknown>) => send('PATCH', `/v1/tasks/${id}`, body);
  const created = async (res: Response) => ((await res.json()) as { data: { id: string } }).data.id;

  describe('POST', () => {
    it('ignores server-owned columns a client sends', async () => {
      const res = await post({
        title: 'Hostile create',
        projectId: 'proj_xrel_a',
        deletedAt: '2020-01-01T00:00:00.000Z',
        key: 'HACK-1',
        watchers: ['someone'],
        position: 9999,
        progress: '100',
        githubIssueNumber: 42,
        completedDate: '2020-01-01T00:00:00.000Z',
        calendarEventId: 'cal_x',
        id: 'task_chosen_by_client',
        number: 7777,
      });
      expect(res.status).toBe(201);
      const stored = await row(await created(res));
      expect(stored).toMatchObject({
        title: 'Hostile create',
        deletedAt: null,
        key: null,
        watchers: null,
        progress: '0.00',
        githubIssueNumber: null,
        completedDate: null,
        calendarEventId: null,
      });
      expect(stored?.id).not.toBe('task_chosen_by_client');
      expect(stored?.number).not.toBe(7777);
      expect(stored?.position).not.toBe(9999);
    });

    it('404s an unknown project', async () => {
      expect((await post({ title: 'Orphan', projectId: 'proj_missing' })).status).toBe(404);
    });

    it('rejects a parent from another project', async () => {
      await seedTask({ id: 'task_xrel_parent_b', projectId: 'proj_xrel_b' });
      const res = await post({ title: 'Child', projectId: 'proj_xrel_a', parentTaskId: 'task_xrel_parent_b' });
      expect(res.status).toBe(400);
    });

    it('rejects a missing parent', async () => {
      const res = await post({ title: 'Child', projectId: 'proj_xrel_a', parentTaskId: 'task_nope' });
      expect(res.status).toBe(400);
    });

    it('syncs both sides of dependsOn / blocks on create', async () => {
      await seedTask({ id: 'task_xrel_pre', projectId: 'proj_xrel_a' });
      await seedTask({ id: 'task_xrel_post', projectId: 'proj_xrel_a' });
      const res = await post({
        title: 'Middle',
        projectId: 'proj_xrel_a',
        dependsOn: ['task_xrel_pre'],
        blocks: ['task_xrel_post'],
      });
      expect(res.status).toBe(201);
      const id = await created(res);
      expect(await row(id)).toMatchObject({ dependsOn: ['task_xrel_pre'], blocks: ['task_xrel_post'] });
      expect((await row('task_xrel_pre'))?.blocks).toEqual([id]);
      expect((await row('task_xrel_post'))?.dependsOn).toEqual([id]);
    });

    it('rejects a link to a task that does not exist, and creates nothing', async () => {
      const res = await post({ title: 'Dangling', projectId: 'proj_xrel_a', dependsOn: ['task_ghost'] });
      expect(res.status).toBe(400);
      const all = await db.select({ title: schema.tasks.title }).from(schema.tasks);
      expect(all.some((r) => r.title === 'Dangling')).toBe(false);
    });

    describe('a task whose links cannot be written is taken back out', () => {
      it('when the linked task is deleted after the up-front check', async () => {
        await seedTask({ id: 'task_xrel_late_new', title: 'Late new', projectId: 'proj_xrel_a' });
        await seedTask({ id: 'task_xrel_late_target', projectId: 'proj_xrel_a', deletedAt: new Date() });

        const failure = await linkCreatedTask(db, 'task_xrel_late_new', { dependsOn: ['task_xrel_late_target'] });

        expect(failure).toMatchObject({ ok: false, kind: 'invalid' });
        expect((await row('task_xrel_late_new'))?.deletedAt).toBeInstanceOf(Date);
      });

      it('when the commit throws, and the error still reaches the caller', async () => {
        await seedTask({ id: 'task_xrel_boom_new', title: 'Boom new', projectId: 'proj_xrel_a' });
        await seedTask({ id: 'task_xrel_boom_target', projectId: 'proj_xrel_a' });
        // The first all-or-nothing write (the link commit) fails; the clean-up that
        // follows goes through.
        let failedOnce = false;
        const failing = new Proxy(db, {
          get(target, prop, receiver) {
            if ((prop === 'batch' || prop === 'transaction') && !failedOnce) {
              return () => {
                failedOnce = true;
                return Promise.reject(new Error('commit failed'));
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as Database;

        await expect(linkCreatedTask(failing, 'task_xrel_boom_new', { dependsOn: ['task_xrel_boom_target'] })).rejects.toThrow(
          'commit failed',
        );
        expect((await row('task_xrel_boom_new'))?.deletedAt).toBeInstanceOf(Date);
        expect((await row('task_xrel_boom_target'))?.blocks ?? []).toEqual([]);
      });

      it('and leaves a task whose links were written alone', async () => {
        await seedTask({ id: 'task_xrel_ok_new', title: 'Ok new', projectId: 'proj_xrel_a' });
        await seedTask({ id: 'task_xrel_ok_target', projectId: 'proj_xrel_a' });

        expect(await linkCreatedTask(db, 'task_xrel_ok_new', { dependsOn: ['task_xrel_ok_target'] })).toBeNull();

        expect((await row('task_xrel_ok_new'))?.deletedAt).toBeNull();
        expect((await row('task_xrel_ok_target'))?.blocks).toEqual(['task_xrel_ok_new']);
      });
    });
  });

  describe('PATCH', () => {
    it('refuses a project change (that is a move, not a column write)', async () => {
      await seedTask({ id: 'task_xrel_stay', projectId: 'proj_xrel_a', sprintId: 'spr_x' });
      const res = await patch('task_xrel_stay', { projectId: 'proj_xrel_b' });
      expect(res.status).toBe(400);
      expect(await row('task_xrel_stay')).toMatchObject({ projectId: 'proj_xrel_a', sprintId: 'spr_x' });
    });

    it('accepts a PATCH that repeats the current project', async () => {
      await seedTask({ id: 'task_xrel_same', projectId: 'proj_xrel_a' });
      expect((await patch('task_xrel_same', { projectId: 'proj_xrel_a', title: 'Renamed' })).status).toBe(200);
      expect((await row('task_xrel_same'))?.title).toBe('Renamed');
    });

    it('rejects a parent from another project and a task as its own parent', async () => {
      await seedTask({ id: 'task_xrel_child', projectId: 'proj_xrel_a' });
      await seedTask({ id: 'task_xrel_other', projectId: 'proj_xrel_b' });
      expect((await patch('task_xrel_child', { parentTaskId: 'task_xrel_other' })).status).toBe(400);
      expect((await patch('task_xrel_child', { parentTaskId: 'task_xrel_child' })).status).toBe(400);
    });

    it('rejects moving a task under its own subtask', async () => {
      await seedTask({ id: 'task_xrel_top', projectId: 'proj_xrel_a' });
      await seedTask({ id: 'task_xrel_sub', projectId: 'proj_xrel_a', parentTaskId: 'task_xrel_top' });
      expect((await patch('task_xrel_top', { parentTaskId: 'task_xrel_sub' })).status).toBe(400);
    });

    it('writes dependency links to both tasks', async () => {
      await seedTask({ id: 'task_xrel_d1', projectId: 'proj_xrel_a' });
      await seedTask({ id: 'task_xrel_d2', projectId: 'proj_xrel_a' });
      expect((await patch('task_xrel_d1', { dependsOn: ['task_xrel_d2'] })).status).toBe(200);
      expect((await row('task_xrel_d1'))?.dependsOn).toEqual(['task_xrel_d2']);
      expect((await row('task_xrel_d2'))?.blocks).toEqual(['task_xrel_d1']);

      expect((await patch('task_xrel_d1', { dependsOn: [] })).status).toBe(200);
      expect((await row('task_xrel_d2'))?.blocks).toEqual([]);
    });

    it('rejects a dependency cycle and writes nothing', async () => {
      await seedTask({ id: 'task_xrel_c1', projectId: 'proj_xrel_a' });
      await seedTask({ id: 'task_xrel_c2', projectId: 'proj_xrel_a' });
      expect((await patch('task_xrel_c1', { dependsOn: ['task_xrel_c2'] })).status).toBe(200);
      const res = await patch('task_xrel_c2', { dependsOn: ['task_xrel_c1'] });
      expect(res.status).toBe(400);
      expect((await row('task_xrel_c2'))?.dependsOn ?? []).toEqual([]);
    });

    it('rejects a self-link and a link to a missing task', async () => {
      await seedTask({ id: 'task_xrel_self', projectId: 'proj_xrel_a' });
      expect((await patch('task_xrel_self', { blocks: ['task_xrel_self'] })).status).toBe(400);
      expect((await patch('task_xrel_self', { dependsOn: ['task_ghost'] })).status).toBe(400);
    });

    it('keeps assigneeId in step with assigneeIds', async () => {
      await seedTask({ id: 'task_xrel_assign', projectId: 'proj_xrel_a' });
      expect((await patch('task_xrel_assign', { assigneeIds: ['u_1', 'u_2'] })).status).toBe(200);
      expect(await row('task_xrel_assign')).toMatchObject({ assigneeId: 'u_1', assigneeIds: ['u_1', 'u_2'] });
    });

    it('does not let a body write server-owned columns', async () => {
      await seedTask({ id: 'task_xrel_owned', projectId: 'proj_xrel_a' });
      expect((await patch('task_xrel_owned', { deletedAt: '2020-01-01T00:00:00.000Z', key: 'X-1', title: 'ok' })).status).toBe(200);
      expect(await row('task_xrel_owned')).toMatchObject({ title: 'ok', deletedAt: null, key: null });
    });
  });
});
