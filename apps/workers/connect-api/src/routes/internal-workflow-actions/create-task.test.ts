/**
 * WeldConnect `create_task` action over the internal route, against pglite:
 * the owner's `tasks:create` permission AND their write access to the
 * target project are both checked at run time, `@weldsuite/flow-domain`'s
 * task service writes the row, and the entity event carries the run's
 * chain depth.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
const published: Array<Record<string, unknown>> = [];

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => db };
});

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return {
    ...actual,
    publishEntityEventRaw: async (event: Record<string, unknown>) => {
      published.push(event);
    },
  };
});

const { internalWorkflowActionsRoutes } = await import('./index');

function app() {
  const root = new Hono<{ Variables: { internalTrusted: boolean } }>();
  root.use('*', async (c, next) => {
    c.set('internalTrusted', true);
    await next();
  });
  root.route('/', internalWorkflowActionsRoutes as never);
  return (path: string, body: unknown) =>
    root.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, {});
}

const actor = (ownerUserId: string) => ({ workspaceId: 'org_1', ownerUserId, triggeredBy: 'system', chainDepth: 1 });

const PROJECT_WITH_MEMBER = 'proj_member';
const PROJECT_NO_MEMBER = 'proj_no_member';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_member', userId: 'member_1', role: 'MEMBER' },
    { id: 'wm_viewer', userId: 'viewer_1', role: 'VIEWER' },
    { id: 'wm_admin', userId: 'admin_1', role: 'ADMIN' },
    { id: 'wm_nonmember', userId: 'nonmember_1', role: 'MEMBER' },
  ]);
  const now = new Date();
  await db.insert(schema.projects).values([
    { id: PROJECT_WITH_MEMBER, name: 'With member', createdAt: now, updatedAt: now },
    { id: PROJECT_NO_MEMBER, name: 'No member', createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.projectMembers).values({
    id: 'pm_member_1',
    projectId: PROJECT_WITH_MEMBER,
    userId: 'member_1',
    role: 'member',
    isActive: true,
  });
}, 60_000);

beforeEach(() => {
  published.length = 0;
});

describe('POST /create-task', () => {
  it('creates the task as the owner and publishes project_task:created with the chain depth', async () => {
    const res = await app()('/create-task', {
      ...actor('member_1'),
      projectId: PROJECT_WITH_MEMBER,
      task: { title: 'Ship the thing', priority: 'high', assigneeIds: ['member_1'] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; task: { id: string; number: number | null; projectId: string } };
    expect(body.success).toBe(true);
    expect(body.task.projectId).toBe(PROJECT_WITH_MEMBER);

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, body.task.id));
    expect(row).toMatchObject({
      title: 'Ship the thing',
      priority: 'high',
      projectId: PROJECT_WITH_MEMBER,
      reporterId: 'member_1',
      assigneeId: 'member_1',
    });
    expect(published).toEqual([
      expect.objectContaining({ entityType: 'project_task', action: 'created', userId: 'member_1', workflowDepth: 1 }),
    ]);
  });

  it('refuses when the owner may not create tasks', async () => {
    const res = await app()('/create-task', {
      ...actor('viewer_1'),
      projectId: PROJECT_WITH_MEMBER,
      task: { title: 'No' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission to create tasks/);
  });

  it('refuses when the owner has tasks:create but is not a member of the project', async () => {
    const res = await app()('/create-task', {
      ...actor('nonmember_1'),
      projectId: PROJECT_NO_MEMBER,
      task: { title: 'No' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/write access to this project/);
  });

  it('refuses when the owner left the workspace', async () => {
    const res = await app()('/create-task', {
      ...actor('gone_1'),
      projectId: PROJECT_WITH_MEMBER,
      task: { title: 'No' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/no longer a member/);
  });

  it('lets an owner with projects:scope:all create a task in a project they are not a member of', async () => {
    const res = await app()('/create-task', {
      ...actor('admin_1'),
      projectId: PROJECT_NO_MEMBER,
      task: { title: 'Admin task' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a missing title before touching the database', async () => {
    const res = await app()('/create-task', {
      ...actor('member_1'),
      projectId: PROJECT_WITH_MEMBER,
      task: {},
    });
    expect(res.status).toBe(400);
  });
});
