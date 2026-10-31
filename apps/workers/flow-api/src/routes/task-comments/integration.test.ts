/**
 * DB-backed tests for /api/task-comments: who may delete (TASK-792) and what the
 * list shows for deleted or unknown tasks (TASK-793).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskCommentsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();
  await db.insert(schema.projects).values([
    { id: 'proj_tc', name: 'P', createdAt: now, updatedAt: now },
  ] as (typeof schema.projects.$inferInsert)[]);
  await db.insert(schema.tasks).values([
    { id: 'task_tc_live', title: 'Live', projectId: 'proj_tc' },
    { id: 'task_tc_gone', title: 'Gone', projectId: 'proj_tc', deletedAt: now },
    { id: 'task_tc_personal', title: 'Personal' },
  ] as (typeof schema.tasks.$inferInsert)[]);
}, 60_000);

const seedComment = (id: string, taskId: string, authorId: string) =>
  db.insert(schema.taskComments).values({
    id,
    taskId,
    taskType: 'project',
    content: id,
    authorId,
  } as typeof schema.taskComments.$inferInsert);
const isDeleted = async (id: string) => {
  const [found] = await db.select().from(schema.taskComments).where(eq(schema.taskComments.id, id)).limit(1);
  return found?.deletedAt != null;
};

/** A caller holding only the default member permissions: tasks:update, not tasks:delete. */
const asMember = (userId: string, ...extra: string[]) =>
  createTestApp('/api/task-comments', taskCommentsRoutes, {
    context: { userId, permissions: permissions('tasks:read', 'tasks:update', ...extra), tenantDb: db },
  });

describe('DELETE /api/task-comments/:id', () => {
  it('lets a member delete their own comment with only tasks:update', async () => {
    await seedComment('tcmt_own', 'task_tc_personal', 'user_author');
    const res = await asMember('user_author').request('/api/task-comments/tcmt_own', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await isDeleted('tcmt_own')).toBe(true);
  });

  it('refuses a member deleting someone else’s comment', async () => {
    await seedComment('tcmt_foreign', 'task_tc_personal', 'user_author');
    const res = await asMember('user_member').request('/api/task-comments/tcmt_foreign', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(await isDeleted('tcmt_foreign')).toBe(false);
  });

  it('lets a project admin or owner moderate any comment on the project’s tasks', async () => {
    await db.insert(schema.projectMembers).values([
      { id: 'pm_tc_admin', projectId: 'proj_tc', userId: 'user_admin', role: 'admin', isActive: true },
      { id: 'pm_tc_member', projectId: 'proj_tc', userId: 'user_pm', role: 'member', isActive: true },
    ] as (typeof schema.projectMembers.$inferInsert)[]);
    await seedComment('tcmt_mod_1', 'task_tc_live', 'user_author');
    await seedComment('tcmt_mod_2', 'task_tc_live', 'user_author');

    const plain = await asMember('user_pm').request('/api/task-comments/tcmt_mod_1', { method: 'DELETE' });
    expect(plain.status).toBe(403);

    const admin = await asMember('user_admin').request('/api/task-comments/tcmt_mod_2', { method: 'DELETE' });
    expect(admin.status).toBe(204);
    expect(await isDeleted('tcmt_mod_2')).toBe(true);

    const scopeAll = await asMember('user_boss', 'projects:scope:all').request('/api/task-comments/tcmt_mod_1', {
      method: 'DELETE',
    });
    expect(scopeAll.status).toBe(204);
  });

  it('is still gated: a caller without tasks:update gets 403', async () => {
    await seedComment('tcmt_gate', 'task_tc_personal', 'user_author');
    const { request } = createTestApp('/api/task-comments', taskCommentsRoutes, {
      context: { userId: 'user_author', permissions: permissions('tasks:read'), tenantDb: db },
    });
    expect((await request('/api/task-comments/tcmt_gate', { method: 'DELETE' })).status).toBe(403);
  });
});

describe('GET /api/task-comments', () => {
  it('leaves out the comments of deleted tasks when no task is given', async () => {
    await seedComment('tcmt_list_live', 'task_tc_live', 'user_author');
    await seedComment('tcmt_list_gone', 'task_tc_gone', 'user_author');

    // scope:all (no project filter) and a plain member both exclude the deleted task's comments.
    for (const caller of [asMember('user_boss', 'projects:scope:all'), asMember('user_admin')]) {
      const res = await caller.request('/api/task-comments?limit=200');
      const ids = ((await res.json()) as { data: { id: string }[] }).data.map((comment) => comment.id);
      expect(ids).toContain('tcmt_list_live');
      expect(ids).not.toContain('tcmt_list_gone');
    }
  });

  it('answers 404 for a task that does not exist or was deleted', async () => {
    const caller = asMember('user_boss', 'projects:scope:all');
    expect((await caller.request('/api/task-comments?taskId=task_tc_gone')).status).toBe(404);
    expect((await caller.request('/api/task-comments?taskId=task_nope')).status).toBe(404);
    expect((await caller.request('/api/task-comments?taskId=task_tc_live')).status).toBe(200);
  });
});

describe('POST, GET /:id and PATCH /api/task-comments', () => {
  beforeAll(async () => {
    await db.insert(schema.projects).values([
      { id: 'proj_tc_rw', name: 'RW', createdAt: new Date(), updatedAt: new Date() },
    ] as (typeof schema.projects.$inferInsert)[]);
    await db.insert(schema.projectMembers).values([
      { id: 'pm_tc_rw_writer', projectId: 'proj_tc_rw', userId: 'user_writer', role: 'member', isActive: true },
      { id: 'pm_tc_rw_watcher', projectId: 'proj_tc_rw', userId: 'user_watcher', role: 'member', isActive: true },
    ] as (typeof schema.projectMembers.$inferInsert)[]);
    await db.insert(schema.workspaceMembers).values([
      { id: 'wm_tc_writer', userId: 'user_writer', email: 'writer@example.com', name: 'Wendy Writer', status: 'active' },
      { id: 'wm_tc_watcher', userId: 'user_watcher', email: 'watcher@example.com', name: 'Walt Watcher', status: 'active' },
    ] as (typeof schema.workspaceMembers.$inferInsert)[]);
    await db.insert(schema.tasks).values([
      {
        id: 'task_tc_rw',
        title: 'Write the brief',
        projectId: 'proj_tc_rw',
        assigneeId: 'user_watcher',
        reporterId: 'user_writer',
      },
    ] as (typeof schema.tasks.$inferInsert)[]);
  });

  const asWriter = (userId = 'user_writer') =>
    createTestApp('/api/task-comments', taskCommentsRoutes, {
      context: { userId, permissions: permissions('tasks:read', 'tasks:create', 'tasks:update'), tenantDb: db },
    });
  const post = (userId: string, body: unknown) =>
    asWriter(userId).request('/api/task-comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const patch = (userId: string, id: string, body: unknown) =>
    asWriter(userId).request(`/api/task-comments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates a comment as the caller, reads it back and lists it with the author', async () => {
    const res = await post('user_writer', { taskId: 'task_tc_rw', content: 'Draft is up, <@user_watcher>' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; authorId: string; taskId: string } };
    expect(data.id).toMatch(/^tcmt_/);
    expect(data.authorId).toBe('user_writer');

    const read = await asWriter().request(`/api/task-comments/${data.id}`);
    expect(read.status).toBe(200);
    const { data: row } = (await read.json()) as { data: { taskType: string; content: string } };
    expect(row.taskType).toBe('project');
    expect(row.content).toBe('Draft is up, <@user_watcher>');

    const list = await asWriter().request('/api/task-comments?taskId=task_tc_rw&page=1&limit=10');
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: { id: string; authorName: string }[] };
    expect(listed.data.find((comment) => comment.id === data.id)?.authorName).toBe('Wendy Writer');
  });

  it('validates the body and refuses tasks it cannot write to or that do not exist', async () => {
    expect((await post('user_writer', { taskId: 'task_tc_rw', content: '' })).status).toBe(400);
    expect((await post('user_writer', { content: 'No task' })).status).toBe(400);
    expect((await post('user_writer', { taskId: 'task_tc_missing', content: 'Hi' })).status).toBe(404);
    expect((await post('user_stranger', { taskId: 'task_tc_rw', content: 'Hi' })).status).toBe(403);
    expect((await asWriter().request('/api/task-comments?limit=0')).status).toBe(400);
  });

  it('answers 404 for an unknown comment and 403 for one on a project the caller is not in', async () => {
    const res = await post('user_writer', { taskId: 'task_tc_rw', content: 'Members only' });
    const { data } = (await res.json()) as { data: { id: string } };
    expect((await asWriter().request('/api/task-comments/tcmt_missing')).status).toBe(404);
    expect((await asWriter('user_stranger').request(`/api/task-comments/${data.id}`)).status).toBe(403);
  });

  it('lets only the author edit a comment', async () => {
    const res = await post('user_writer', { taskId: 'task_tc_rw', content: 'Typo hree' });
    const { data } = (await res.json()) as { data: { id: string } };

    expect((await patch('user_watcher', data.id, { content: 'Hijacked' })).status).toBe(403);
    expect((await patch('user_writer', data.id, { content: '' })).status).toBe(400);
    expect((await patch('user_writer', 'tcmt_missing', { content: 'Nope' })).status).toBe(404);

    const edited = await patch('user_writer', data.id, { content: 'Typo here' });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ data: { id: data.id, content: 'Typo here' } });
    const [stored] = await db.select().from(schema.taskComments).where(eq(schema.taskComments.id, data.id));
    expect(stored?.content).toBe('Typo here');
  });
});
