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
  return { ...actual, publishEntityEvent: vi.fn() };
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
