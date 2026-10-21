/**
 * DB-backed integration tests for /api/projects.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/projects · pglite integration', () => {
  it('POST / writes a project row', async () => {
    const { request } = createTestApp('/api/projects', projectsRoutes, {
      context: { permissions: permissions('projects:create'), tenantDb: db },
    });

    const res = await request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Q1 Sprint',
        description: 'Test project',
        color: '#3b82f6',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^prj_/);

    const [row] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Q1 Sprint');
    expect(row?.description).toBe('Test project');
  });

  it('POST / stores the status in its canonical casing and the list filter is spelling-insensitive', async () => {
    const { request: create } = createTestApp('/api/projects', projectsRoutes, {
      context: { permissions: permissions('projects:create'), tenantDb: db },
    });
    const res = await create('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Case project', status: 'on_hold' }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, data.id)).limit(1);
    expect(row?.status).toBe('On Hold');

    // A legacy lowercase row is still found by the canonical filter value.
    await db.insert(schema.projects).values({
      id: 'prj_legacy_lower',
      name: 'Legacy lowercase',
      status: 'planning',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as typeof schema.projects.$inferInsert);

    const { request: read } = createTestApp('/api/projects', projectsRoutes, {
      context: { permissions: permissions('projects:read', 'projects:scope:all'), tenantDb: db },
    });
    const listRes = await read('/api/projects?status=Planning');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(list.data.some((p) => p.id === 'prj_legacy_lower')).toBe(true);
    expect(list.data.some((p) => p.id === data.id)).toBe(false);
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/projects', projectsRoutes, {
      context: { permissions: permissions('projects:create'), tenantDb: db },
    });
    const res = await request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns 404 for missing project', async () => {
    // An elevated (scope:all) caller passes the access gate, so a missing id
    // resolves to a genuine 404 rather than the membership 403.
    const { request } = createTestApp('/api/projects', projectsRoutes, {
      context: { permissions: permissions('projects:read', 'projects:scope:all'), tenantDb: db },
    });
    const res = await request('/api/projects/prj_missing');
    expect(res.status).toBe(404);
  });

  describe('GET /:id/permissions', () => {
    let projectId: string;

    beforeAll(async () => {
      // Managed by someone else; the test caller has no member row.
      projectId = 'prj_perm_test';
      await db.insert(schema.projects).values({
        id: projectId,
        name: 'Someone else\'s project',
        projectManagerId: 'user_other',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('grants a workspace admin (projects:scope:all) full rights without a member row', async () => {
      const { request } = createTestApp('/api/projects', projectsRoutes, {
        context: { permissions: permissions('projects:read', 'projects:scope:all'), tenantDb: db },
      });
      const res = await request(`/api/projects/${projectId}/permissions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { role: string | null; canRead: boolean; canWrite: boolean; isAdmin: boolean };
      };
      expect(body.data).toMatchObject({ canRead: true, canWrite: true, isAdmin: true });
    });

    it('grants nothing to a non-member without projects:scope:all', async () => {
      const { request } = createTestApp('/api/projects', projectsRoutes, {
        context: { permissions: permissions('projects:read'), tenantDb: db },
      });
      const res = await request(`/api/projects/${projectId}/permissions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { role: string | null; canRead: boolean; canWrite: boolean; isAdmin: boolean };
      };
      expect(body.data).toEqual({ role: null, canRead: false, canWrite: false, isAdmin: false });
    });
  });

  describe('DELETE /:id', () => {
    const SOURCE = 'prj_del_source';
    const DEST = 'prj_del_dest';
    const admin = () =>
      createTestApp('/api/projects', projectsRoutes, {
        context: { permissions: permissions('projects:delete', 'projects:scope:all'), tenantDb: db },
      }).request;

    const seedProject = (id: string) =>
      db.insert(schema.projects).values({ id, name: id, createdAt: new Date(), updatedAt: new Date() });
    const project = async (id: string) =>
      (await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1))[0];
    const task = async (id: string) =>
      (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1))[0];

    beforeAll(async () => {
      await seedProject(SOURCE);
      await seedProject(DEST);
      await db.insert(schema.projectPipelineStages).values([
        { id: 'stg_src_todo', projectId: SOURCE, name: 'To do', systemStatus: 'todo', position: 0 },
        { id: 'stg_dest_todo', projectId: DEST, name: 'Backlog', systemStatus: 'todo', position: 0 },
        { id: 'stg_dest_done', projectId: DEST, name: 'Done', systemStatus: 'done', position: 1 },
      ]);
      await db.insert(schema.tasks).values([
        { id: 'tsk_del_existing', projectId: DEST, title: 'Already there', status: 'todo', position: 4 },
        { id: 'tsk_del_done', projectId: SOURCE, title: 'Done task', status: 'done', stageId: 'stg_src_todo', sprintId: 'spr_x', key: 'SRC-1', position: 1 },
        { id: 'tsk_del_review', projectId: SOURCE, title: 'In review', status: 'review', position: 2 },
        { id: 'tsk_del_child', projectId: SOURCE, title: 'Subtask', status: 'todo', parentTaskId: 'tsk_del_done', position: 3 },
      ]);
    });

    it('refuses moving the tasks into the project being deleted', async () => {
      const res = await admin()(`/api/projects/${SOURCE}?moveTasksTo=${SOURCE}`, { method: 'DELETE' });
      expect(res.status).toBe(400);
      expect((await project(SOURCE))?.deletedAt).toBeNull();
    });

    it('404s on a missing destination and leaves the project alone', async () => {
      const res = await admin()(`/api/projects/${SOURCE}?moveTasksTo=prj_missing`, { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect((await project(SOURCE))?.deletedAt).toBeNull();
    });

    it('moves the tasks to the destination, then deletes the project', async () => {
      const res = await admin()(`/api/projects/${SOURCE}?moveTasksTo=${DEST}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect((await project(SOURCE))?.deletedAt).not.toBeNull();

      // Matching status keeps it and picks the destination's stage for it.
      expect(await task('tsk_del_done')).toMatchObject({
        projectId: DEST,
        stageId: 'stg_dest_done',
        status: 'done',
        sprintId: null,
        key: null,
        position: 6,
      });
      // No 'review' stage in the destination: first stage, its status.
      expect(await task('tsk_del_review')).toMatchObject({ projectId: DEST, stageId: 'stg_dest_todo', status: 'todo' });
      // The subtree moved as one, so the parent link stays.
      expect(await task('tsk_del_child')).toMatchObject({ projectId: DEST, parentTaskId: 'tsk_del_done' });
    });

    it('without a destination only soft-deletes the project', async () => {
      const id = 'prj_del_plain';
      await seedProject(id);
      await db.insert(schema.tasks).values({ id: 'tsk_del_plain', projectId: id, title: 'Stays', status: 'todo' });
      const res = await admin()(`/api/projects/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect((await project(id))?.deletedAt).not.toBeNull();
      expect((await task('tsk_del_plain'))?.projectId).toBe(id);
    });
  });
});
