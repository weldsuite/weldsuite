/**
 * DB-backed integration tests for the WeldFlow project-surface hardening batch:
 *  - soft-deleted projects stop granting access and stop showing up (TASK-777)
 *  - project / milestone / sprint / label writes are allow-listed, dates coerced
 *    (TASK-861, TASK-769, TASK-784)
 *  - member roles are a closed set, owner changes are guarded (TASK-773)
 *  - labels, documents and messages respect project membership (TASK-765, 766, 864, 792)
 *  - workload overview scope / capacity / buckets (TASK-791)
 *  - All Projects filters and sorting (TASK-799), case-insensitive search (TASK-789)
 *  - completed / started lifecycle events (TASK-788)
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../types';
import { projectsRoutes } from './projects';
import { milestonesRoutes } from './milestones';
import { sprintsRoutes } from './sprints';
import { projectLabelsRoutes } from './project-labels';
import { projectMembersRoutes } from './project-members';
import { documentsRoutes } from './documents';
import { projectDocumentsRoutes } from './project-documents';
import { projectMessagesRoutes } from './project-messages';
import { whiteboardsRoutes } from './whiteboards';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/projects', projectsRoutes);
router.route('/milestones', milestonesRoutes);
router.route('/sprints', sprintsRoutes);
router.route('/project-labels', projectLabelsRoutes);
router.route('/project-members', projectMembersRoutes);
router.route('/documents', documentsRoutes);
router.route('/project-documents', projectDocumentsRoutes);
router.route('/project-messages', projectMessagesRoutes);
router.route('/whiteboards', whiteboardsRoutes);

// Feature-level grants of a plain workspace member (no scope:all). Deliberately
// without projects:delete, which MEMBER does not hold by default.
const MEMBER_PERMISSIONS = [
  'projects:read',
  'projects:create',
  'projects:update',
  'milestones:read',
  'milestones:create',
  'milestones:update',
  'milestones:delete',
  'files:read',
  'files:create',
  'files:update',
  'tasks:read',
];

const flagsOn = { isOn: async () => true } as unknown as NonNullable<Variables['flags']>;

const P1 = 'prj_hard_one';
const P2 = 'prj_hard_two';
const MANAGER = 'user_h_manager';
const OWNER = 'user_h_owner';
const ADMIN = 'user_h_admin';
const MEMBER = 'user_h_member';
const VIEWER = 'user_h_viewer';
const OUTSIDER = 'user_h_outsider';
const SCOPE_ALL = 'user_h_scope_all';
const NEWBIE = 'user_h_newbie';
const GHOST = 'user_h_not_in_workspace';

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, extra: string[] = [], base: string[] = MEMBER_PERMISSIONS): Send {
  const { request } = createTestApp('/api', router, {
    context: { userId, permissions: permissions(...base, ...extra), tenantDb: db, flags: flagsOn },
  });
  return async (method, path, body) =>
    request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const asScopeAll = () => as(SCOPE_ALL, ['projects:scope:all', 'projects:delete']);

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function seedProject(id: string, managerId: string, extra: Partial<typeof schema.projects.$inferInsert> = {}) {
  const now = new Date();
  await db
    .insert(schema.projects)
    .values({ id, name: `Project ${id}`, projectManagerId: managerId, createdAt: now, updatedAt: now, ...extra })
    .onConflictDoNothing();
}

async function seedMember(projectId: string, userId: string, role: string, extra: Partial<typeof schema.projectMembers.$inferInsert> = {}) {
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
      ...extra,
    })
    .onConflictDoNothing();
}

async function seedWorkspaceMember(userId: string, name: string, extra: Partial<typeof schema.workspaceMembers.$inferInsert> = {}) {
  await db
    .insert(schema.workspaceMembers)
    .values({ id: `wm_${userId}`, userId, name, email: `${userId}@example.com`, ...extra })
    .onConflictDoNothing();
}

async function seedTask(projectId: string, title: string, extra: Partial<typeof schema.tasks.$inferInsert> = {}) {
  const id = `task_${Math.random().toString(36).slice(2, 12)}`;
  await db.insert(schema.tasks).values({ id, projectId, title, status: 'todo', ...extra });
  return id;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedProject(P1, MANAGER);
  await seedProject(P2, MANAGER);
  await seedMember(P1, OWNER, 'owner');
  await seedMember(P1, ADMIN, 'admin');
  await seedMember(P1, MEMBER, 'member');
  await seedMember(P1, VIEWER, 'viewer');
  for (const [id, name] of [
    [MANAGER, 'Manny Manager'],
    [OWNER, 'Olivia Owner'],
    [ADMIN, 'Adam Admin'],
    [MEMBER, 'Mia Member'],
    [VIEWER, 'Vic Viewer'],
    [OUTSIDER, 'Otto Outsider'],
    [NEWBIE, 'Nina Newbie'],
  ]) {
    await seedWorkspaceMember(id, name);
  }
}, 60_000);

beforeEach(() => {
  vi.mocked(publishEntityEvent).mockClear();
});

function eventActions(entityType: string): string[] {
  return vi
    .mocked(publishEntityEvent)
    .mock.calls.map(([arg]) => arg as { entityType: string; action: string })
    .filter((arg) => arg.entityType === entityType)
    .map((arg) => arg.action);
}

describe('soft-deleted projects (TASK-777)', () => {
  const GONE = 'prj_hard_gone';

  beforeAll(async () => {
    await seedProject(GONE, MANAGER, { deletedAt: new Date() });
    await seedMember(GONE, MEMBER, 'member');
    await seedTask(GONE, 'Task in a deleted project', { assigneeId: MEMBER });
  });

  it('a member, the manager and a scope:all admin all lose access to a deleted project', async () => {
    for (const send of [as(MEMBER), as(MANAGER), asScopeAll()]) {
      expect((await send('GET', `/projects/${GONE}`)).status).toBe(403);
      expect((await send('GET', `/project-members?projectId=${GONE}`)).status).toBe(403);
      expect((await send('GET', `/projects/${GONE}/workload`)).status).toBe(403);
    }
    const perms = await json<{ data: { canRead: boolean; canWrite: boolean; isAdmin: boolean } }>(
      await asScopeAll()('GET', `/projects/${GONE}/permissions`),
    );
    expect(perms.data).toMatchObject({ canRead: false, canWrite: false, isAdmin: false });
  });

  it('writes under a deleted project are refused', async () => {
    const res = await as(MEMBER)('POST', '/milestones', { name: 'M', projectId: GONE, dueDate: '2030-01-01' });
    expect(res.status).toBe(403);
    const sprint = await asScopeAll()('POST', '/sprints', { name: 'S', projectId: GONE });
    expect(sprint.status).toBe(403);
  });

  it('is left out of the projects list and the workload overview', async () => {
    const list = await json<{ data: Array<{ id: string }> }>(await as(MEMBER)('GET', '/projects'));
    expect(list.data.some((p) => p.id === GONE)).toBe(false);

    for (const send of [as(MEMBER), asScopeAll()]) {
      const overview = await json<{ data: { teamMembers: Array<{ tasks: Array<{ projectId: string }> }>; unassigned: { tasks: Array<{ projectId: string }> } } }>(
        await send('GET', '/projects/workload/overview'),
      );
      const projectIds = [
        ...overview.data.teamMembers.flatMap((m) => m.tasks.map((t) => t.projectId)),
        ...overview.data.unassigned.tasks.map((t) => t.projectId),
      ];
      expect(projectIds).not.toContain(GONE);
    }
  });
});

describe('mass assignment on projects (TASK-861, TASK-769)', () => {
  it('POST ignores id, deletedAt, counters and audit columns; dates are coerced', async () => {
    const res = await as(MEMBER)('POST', '/projects', {
      name: 'Allow-listed',
      id: 'prj_attacker_chosen',
      deletedAt: '2020-01-01T00:00:00.000Z',
      totalTasks: 999,
      completedTasks: 500,
      createdAt: '2001-01-01T00:00:00.000Z',
      startDate: '2030-02-01T00:00:00.000Z',
      endDate: '2030-03-01T00:00:00.000Z',
      priority: 'high',
    });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: { id: string } }>(res);
    expect(data.id).not.toBe('prj_attacker_chosen');
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, data.id)).limit(1);
    expect(row?.deletedAt).toBeNull();
    expect(row?.totalTasks).toBe(0);
    expect(row?.completedTasks).toBe(0);
    expect(row?.createdAt.getUTCFullYear()).toBeGreaterThan(2020);
    expect(row?.priority).toBe('high');
    expect(row?.startDate?.toISOString()).toBe('2030-02-01T00:00:00.000Z');
    expect(row?.endDate?.toISOString()).toBe('2030-03-01T00:00:00.000Z');
    expect(row?.projectManagerId).toBe(MEMBER);
    const stray = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_attacker_chosen'));
    expect(stray).toHaveLength(0);
  });

  it('PATCH ignores id, deletedAt and counters but updates allow-listed columns and dates', async () => {
    const send = as(OWNER);
    const res = await send('PATCH', `/projects/${P1}`, {
      id: 'prj_renamed_pk',
      deletedAt: new Date().toISOString(),
      totalTasks: 42,
      openTasks: 42,
      description: 'Edited description',
      endDate: '2031-04-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, P1)).limit(1);
    expect(row?.id).toBe(P1);
    expect(row?.deletedAt).toBeNull();
    expect(row?.totalTasks).toBe(0);
    expect(row?.openTasks).toBe(0);
    expect(row?.description).toBe('Edited description');
    expect(row?.endDate?.toISOString()).toBe('2031-04-01T00:00:00.000Z');
  });

  it('rejects an unparseable date with 400 instead of a 500', async () => {
    const res = await as(OWNER)('PATCH', `/projects/${P1}`, { endDate: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});

describe('milestones and sprints (TASK-861, 769, 784, 788)', () => {
  it('milestone PATCH coerces the ISO dueDate sent by a Gantt drag', async () => {
    const send = as(MEMBER);
    const created = await send('POST', '/milestones', {
      name: 'Gantt milestone',
      projectId: P1,
      dueDate: '2030-05-01T00:00:00.000Z',
      id: 'ms_attacker',
      completedAt: '2001-01-01T00:00:00.000Z',
      totalTasks: 77,
    });
    expect(created.status).toBe(201);
    const { data } = await json<{ data: { id: string } }>(created);
    expect(data.id).not.toBe('ms_attacker');
    let [row] = await db.select().from(schema.milestones).where(eq(schema.milestones.id, data.id)).limit(1);
    expect(row?.completedAt).toBeNull();
    expect(row?.totalTasks).toBe(0);

    const moved = await send('PATCH', `/milestones/${data.id}`, { dueDate: '2030-06-15T10:00:00.000Z' });
    expect(moved.status).toBe(200);
    [row] = await db.select().from(schema.milestones).where(eq(schema.milestones.id, data.id)).limit(1);
    expect(row?.dueDate.toISOString()).toBe('2030-06-15T10:00:00.000Z');
  });

  it('completing a milestone stamps completedAt and publishes milestone.completed once', async () => {
    const send = as(MEMBER);
    const { data } = await json<{ data: { id: string } }>(
      await send('POST', '/milestones', { name: 'To complete', projectId: P1, dueDate: '2030-01-01' }),
    );
    vi.mocked(publishEntityEvent).mockClear();

    expect((await send('PATCH', `/milestones/${data.id}`, { status: 'completed' })).status).toBe(200);
    expect(eventActions('project_milestone')).toEqual(['updated', 'completed']);
    const [done] = await db.select().from(schema.milestones).where(eq(schema.milestones.id, data.id)).limit(1);
    expect(done?.completedAt).toBeInstanceOf(Date);

    // Already completed: another PATCH is only an update.
    vi.mocked(publishEntityEvent).mockClear();
    await send('PATCH', `/milestones/${data.id}`, { name: 'Renamed' });
    expect(eventActions('project_milestone')).toEqual(['updated']);

    // Reopening clears the stamp.
    await send('PATCH', `/milestones/${data.id}`, { status: 'in_progress' });
    const [reopened] = await db.select().from(schema.milestones).where(eq(schema.milestones.id, data.id)).limit(1);
    expect(reopened?.completedAt).toBeNull();
  });

  it('sprint create/update coerce dates, ignore unlisted columns and publish started / completed', async () => {
    const send = as(MEMBER);
    const created = await send('POST', '/sprints', {
      name: 'Sprint 1',
      projectId: P1,
      startDate: '2030-01-01T00:00:00.000Z',
      endDate: '2030-01-14T00:00:00.000Z',
      id: 'spr_attacker',
      startedAt: '2001-01-01T00:00:00.000Z',
    });
    expect(created.status).toBe(201);
    const { data } = await json<{ data: { id: string } }>(created);
    expect(data.id).not.toBe('spr_attacker');
    let [row] = await db.select().from(schema.sprints).where(eq(schema.sprints.id, data.id)).limit(1);
    expect(row?.startedAt).toBeNull();
    expect(row?.startDate?.toISOString()).toBe('2030-01-01T00:00:00.000Z');

    vi.mocked(publishEntityEvent).mockClear();
    expect((await send('PATCH', `/sprints/${data.id}`, { status: 'active', endDate: '2030-01-20T00:00:00.000Z' })).status).toBe(200);
    expect(eventActions('project_sprint')).toEqual(['updated', 'started']);
    [row] = await db.select().from(schema.sprints).where(eq(schema.sprints.id, data.id)).limit(1);
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.endDate?.toISOString()).toBe('2030-01-20T00:00:00.000Z');

    vi.mocked(publishEntityEvent).mockClear();
    expect((await send('PATCH', `/sprints/${data.id}`, { status: 'completed' })).status).toBe(200);
    expect(eventActions('project_sprint')).toEqual(['updated', 'completed']);
    [row] = await db.select().from(schema.sprints).where(eq(schema.sprints.id, data.id)).limit(1);
    expect(row?.completedAt).toBeInstanceOf(Date);
  });
});

describe('project labels (TASK-765, TASK-769)', () => {
  let p1Label = '';

  beforeAll(async () => {
    const res = await as(MEMBER)('POST', '/project-labels', { name: 'P1 only', color: '#112233', projectId: P1 });
    expect(res.status).toBe(201);
    p1Label = (await json<{ data: { id: string } }>(res)).data.id;
    const global = await asScopeAll()('POST', '/project-labels', { name: 'Everywhere', color: '#445566' });
    expect(global.status).toBe(201);
  });

  it('a non-member cannot list, read or write a project\'s labels', async () => {
    const send = as(OUTSIDER);
    expect((await send('GET', `/project-labels?projectId=${P1}`)).status).toBe(403);
    expect((await send('GET', `/project-labels/${p1Label}`)).status).toBe(403);
    expect((await send('POST', '/project-labels', { name: 'Sneaky', color: '#000000', projectId: P1 })).status).toBe(403);
    expect((await send('PATCH', `/project-labels/${p1Label}`, { name: 'Hijacked' })).status).toBe(403);
    expect((await send('DELETE', `/project-labels/${p1Label}`)).status).toBe(403);
  });

  it('the unscoped list shows workspace-wide labels plus the caller\'s own projects only', async () => {
    const names = async (send: Send) =>
      (await json<{ data: Array<{ name: string }> }>(await send('GET', '/project-labels'))).data.map((l) => l.name);
    const outsider = await names(as(OUTSIDER));
    expect(outsider).toContain('Everywhere');
    expect(outsider).not.toContain('P1 only');
    expect(await names(as(MEMBER))).toContain('P1 only');
    expect(await names(asScopeAll())).toContain('P1 only');
  });

  it('a viewer can read the project labels', async () => {
    expect((await as(VIEWER)('GET', `/project-labels?projectId=${P1}`)).status).toBe(200);
  });

  it('create ignores an attacker-chosen id and keeps only listed columns', async () => {
    const res = await as(MEMBER)('POST', '/project-labels', {
      name: 'Clean', color: '#abcdef', projectId: P1, id: 'plbl_attacker', deletedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: { id: string } }>(res);
    expect(data.id).not.toBe('plbl_attacker');
    const [row] = await db.select().from(schema.projectLabels).where(eq(schema.projectLabels.id, data.id)).limit(1);
    expect(row?.deletedAt).toBeNull();
  });

  it('search is case-insensitive and treats % and _ literally', async () => {
    const send = as(MEMBER);
    await send('POST', '/project-labels', { name: '50% done', color: '#111111', projectId: P1 });
    const found = await json<{ data: Array<{ name: string }> }>(await send('GET', '/project-labels?search=P1%20ONLY'));
    expect(found.data.map((l) => l.name)).toContain('P1 only');
    const literal = await json<{ data: Array<{ name: string }> }>(await send('GET', '/project-labels?search=%25'));
    expect(literal.data.map((l) => l.name)).toEqual(['50% done']);
  });
});

describe('project members (TASK-773)', () => {
  it('rejects a role outside owner / admin / member / viewer', async () => {
    const res = await as(OWNER)('POST', '/project-members', { projectId: P1, userId: NEWBIE, role: 'god' });
    expect(res.status).toBe(400);
  });

  it('refuses a user who is not an active workspace member', async () => {
    const res = await as(OWNER)('POST', '/project-members', { projectId: P1, userId: GHOST, role: 'member' });
    expect(res.status).toBe(400);
  });

  it('a project admin cannot grant owner, an owner can; roles are stored lowercase', async () => {
    const adminTry = await as(ADMIN)('POST', '/project-members', { projectId: P1, userId: NEWBIE, role: 'owner' });
    expect(adminTry.status).toBe(403);

    const ownerOk = await as(OWNER)('POST', '/project-members', { projectId: P1, userId: NEWBIE, role: 'Viewer' });
    expect(ownerOk.status).toBe(201);
    const [row] = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.id, (await json<{ data: { id: string } }>(ownerOk)).data.id))
      .limit(1);
    expect(row?.role).toBe('viewer');

    // Adding the same person again is a clean 400, not a duplicate row.
    expect((await as(OWNER)('POST', '/project-members', { projectId: P1, userId: NEWBIE })).status).toBe(400);

    // Promote to owner: admin refused, owner allowed.
    expect((await as(ADMIN)('PATCH', `/project-members/by-user/${P1}/${NEWBIE}`, { role: 'owner' })).status).toBe(403);
    expect((await as(OWNER)('PATCH', `/project-members/by-user/${P1}/${NEWBIE}`, { role: 'owner' })).status).toBe(200);
  });

  it('an admin cannot demote or remove an owner', async () => {
    expect((await as(ADMIN)('PATCH', `/project-members/by-user/${P1}/${OWNER}`, { role: 'member' })).status).toBe(403);
    expect((await as(ADMIN)('DELETE', `/project-members/by-user/${P1}/${OWNER}`)).status).toBe(403);
  });

  it('the last owner cannot be demoted, deactivated or removed', async () => {
    const SOLO = 'prj_hard_solo';
    await seedProject(SOLO, 'user_h_somebody_else');
    await seedMember(SOLO, OWNER, 'owner');
    const send = as(OWNER, ['projects:delete']);
    // The project manager (somebody else) counts as an owner, so first clear it.
    await db.update(schema.projects).set({ projectManagerId: null }).where(eq(schema.projects.id, SOLO));
    expect((await send('PATCH', `/project-members/by-user/${SOLO}/${OWNER}`, { role: 'admin' })).status).toBe(409);
    expect((await send('PATCH', `/project-members/by-user/${SOLO}/${OWNER}`, { isActive: false })).status).toBe(409);
    expect((await send('DELETE', `/project-members/by-user/${SOLO}/${OWNER}`)).status).toBe(409);
  });

  it('reactivating an inactive owner is a grant: an admin cannot, an owner can', async () => {
    const P = 'prj_hard_reactivate';
    await seedProject(P, MANAGER);
    await seedMember(P, OWNER, 'owner');
    await seedMember(P, ADMIN, 'admin');
    await seedMember(P, NEWBIE, 'owner', { isActive: false });
    const path = `/project-members/by-user/${P}/${NEWBIE}`;

    expect((await as(ADMIN)('PATCH', path, { isActive: true })).status).toBe(403);
    const [stillInactive] = await db
      .select({ isActive: schema.projectMembers.isActive })
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.id, `pm_${P}_${NEWBIE}`));
    expect(stillInactive?.isActive).toBe(false);

    expect((await as(OWNER)('PATCH', path, { isActive: true })).status).toBe(200);
  });

  it('an owner who is already inactive is not an owner: demoting or removing them never needs owner rights or trips the last-owner rule', async () => {
    const P = 'prj_hard_inactive_owner';
    // No manager and no other active owner: only the inactive owner row is left.
    await seedProject(P, 'user_h_somebody_else');
    await db.update(schema.projects).set({ projectManagerId: null }).where(eq(schema.projects.id, P));
    await seedMember(P, ADMIN, 'admin');
    await seedMember(P, NEWBIE, 'owner', { isActive: false });
    await seedMember(P, VIEWER, 'owner', { isActive: false });
    const send = as(ADMIN, ['projects:delete']);

    expect((await send('PATCH', `/project-members/by-user/${P}/${NEWBIE}`, { isActive: false })).status).toBe(200);
    expect((await send('PATCH', `/project-members/by-user/${P}/${NEWBIE}`, { role: 'member' })).status).toBe(200);
    expect((await send('DELETE', `/project-members/by-user/${P}/${VIEWER}`)).status).toBe(204);
  });

  it('hides the hourly rate from everyone but project admins and the member themselves', async () => {
    await db
      .update(schema.projectMembers)
      .set({ hourlyRate: '85.00' })
      .where(eq(schema.projectMembers.id, `pm_${P1}_${MEMBER}`));

    const rateFor = async (send: Send, userId: string) => {
      const list = await json<{ data: Array<{ userId: string; hourlyRate: string | null }> }>(
        await send('GET', `/project-members?projectId=${P1}`),
      );
      return list.data.find((m) => m.userId === userId)?.hourlyRate;
    };
    expect(await rateFor(as(VIEWER), MEMBER)).toBeNull();
    expect(await rateFor(as(MEMBER), MEMBER)).toBe('85.00');
    expect(await rateFor(as(ADMIN), MEMBER)).toBe('85.00');
    expect(await rateFor(asScopeAll(), MEMBER)).toBe('85.00');

    const byUser = await json<{ data: { hourlyRate: string | null } }>(
      await as(VIEWER)('GET', `/project-members/by-user/${P1}/${MEMBER}`),
    );
    expect(byUser.data.hourlyRate).toBeNull();
  });

  it('leaves out members who were removed from the workspace', async () => {
    const P = 'proj_departed';
    const STAYER = 'user_pm_stayer';
    const REMOVED = 'user_pm_removed';
    const SUSPENDED = 'user_pm_suspended';
    await seedProject(P, MANAGER);
    await seedMember(P, STAYER, 'member');
    await seedMember(P, REMOVED, 'member');
    await seedMember(P, SUSPENDED, 'member');
    await seedWorkspaceMember(STAYER, 'Stan Stayer');
    await seedWorkspaceMember(REMOVED, 'Rita Removed', { deletedAt: new Date() });
    await seedWorkspaceMember(SUSPENDED, 'Sue Suspended', { status: 'SUSPENDED' });

    const list = await json<{ data: Array<{ userId: string }> }>(
      await asScopeAll()('GET', `/project-members?projectId=${P}`),
    );
    expect(list.data.map((m) => m.userId)).toEqual([STAYER]);
  });

  it('keeps the rate out of the member update entity event', async () => {
    vi.mocked(publishEntityEvent).mockClear();
    await as(ADMIN)('PATCH', `/project-members/by-user/${P1}/${MEMBER}`, { hourlyRate: 90 });
    const call = vi.mocked(publishEntityEvent).mock.calls.map(([arg]) => arg).find((a) => a.entityType === 'project_member');
    expect(call?.data).not.toHaveProperty('hourlyRate');
  });
});

describe('project manager changes are owner-level', () => {
  const P = 'prj_hard_manager_change';
  const managerOf = async () =>
    (await db.select({ id: schema.projects.projectManagerId }).from(schema.projects).where(eq(schema.projects.id, P)))[0]
      ?.id;

  beforeAll(async () => {
    await seedProject(P, MANAGER);
    await seedMember(P, OWNER, 'owner');
    await seedMember(P, ADMIN, 'admin');
  });

  it('a project admin cannot make themselves the manager (which would make them the owner)', async () => {
    expect((await as(ADMIN)('PATCH', `/projects/${P}`, { projectManagerId: ADMIN })).status).toBe(403);
    expect(await managerOf()).toBe(MANAGER);
  });

  it('a project admin can still edit the project and resend the current manager', async () => {
    expect((await as(ADMIN)('PATCH', `/projects/${P}`, { name: 'Renamed', projectManagerId: MANAGER })).status).toBe(200);
    expect(await managerOf()).toBe(MANAGER);
  });

  it('an owner, the manager and a scope:all admin can hand the seat over', async () => {
    expect((await as(OWNER)('PATCH', `/projects/${P}`, { projectManagerId: OWNER })).status).toBe(200);
    expect(await managerOf()).toBe(OWNER);
    expect((await asScopeAll()('PATCH', `/projects/${P}`, { projectManagerId: MANAGER })).status).toBe(200);
    expect((await as(MANAGER)('PATCH', `/projects/${P}`, { projectManagerId: ADMIN })).status).toBe(200);
    expect(await managerOf()).toBe(ADMIN);
  });
});

describe('project documents (TASK-766, TASK-864, TASK-854)', () => {
  let fileId = '';

  beforeAll(async () => {
    const res = await as(OWNER)('POST', `/project-documents/${P1}`, { name: 'Spec' });
    expect(res.status).toBe(201);
    fileId = (await json<{ data: { id: string } }>(res)).data.id;
  });

  it('refuses a non-member on every /documents/:fileId route', async () => {
    const send = as(OUTSIDER);
    expect((await send('GET', `/documents/${fileId}`)).status).toBe(403);
    expect((await send('PUT', `/documents/${fileId}/content`, { content: [{ type: 'paragraph' }] })).status).toBe(403);
    expect((await send('GET', `/documents/${fileId}/versions`)).status).toBe(403);
    expect((await send('POST', `/documents/${fileId}/versions`, { label: 'x' })).status).toBe(403);
  });

  it('lets a viewer read but not write', async () => {
    const send = as(VIEWER);
    expect((await send('GET', `/documents/${fileId}`)).status).toBe(200);
    expect((await send('GET', `/documents/${fileId}/versions`)).status).toBe(200);
    expect((await send('PUT', `/documents/${fileId}/content`, { content: [{ type: 'paragraph' }] })).status).toBe(403);
    expect((await send('POST', `/documents/${fileId}/versions`, { label: 'x' })).status).toBe(403);
  });

  it('lets a member write; restoring a version first snapshots the current content', async () => {
    const send = as(MEMBER);
    const first = [{ id: 'a', type: 'paragraph', content: 'first' }];
    const second = [{ id: 'b', type: 'paragraph', content: 'second' }];
    expect((await send('PUT', `/documents/${fileId}/content`, { content: first })).status).toBe(200);
    const named = await send('POST', `/documents/${fileId}/versions`, { label: 'v1' });
    expect(named.status).toBe(201);
    const versionId = (await json<{ data: { id: string } }>(named)).data.id;
    expect((await send('PUT', `/documents/${fileId}/content`, { content: second })).status).toBe(200);

    const before = await json<{ data: unknown[] }>(await send('GET', `/documents/${fileId}/versions`));
    expect((await send('POST', `/documents/${fileId}/versions/${versionId}/restore`)).status).toBe(200);
    const after = await json<{ data: Array<{ id: string }> }>(await send('GET', `/documents/${fileId}/versions`));
    expect(after.data).toHaveLength(before.data.length + 1);

    // The overwritten content is recoverable from the new snapshot.
    const rows = await db.select().from(schema.documentVersions).where(eq(schema.documentVersions.fileId, fileId));
    expect(rows.some((r) => JSON.stringify(r.content).includes('second'))).toBe(true);
    const doc = await json<{ data: { content: unknown } }>(await send('GET', `/documents/${fileId}`));
    expect(JSON.stringify(doc.data.content)).toContain('first');

    // A viewer reads a version; an outsider does not.
    const version = await as(VIEWER)('GET', `/documents/${fileId}/versions/${versionId}`);
    expect(version.status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/documents/${fileId}/versions/${versionId}`)).status).toBe(403);
  });

  it('a drive document (no project) is not gated by project membership', async () => {
    const created = await as(OUTSIDER)('POST', '/documents', { name: 'Drive doc' });
    expect(created.status).toBe(201);
    const driveId = (await json<{ data: { id: string } }>(created)).data.id;
    expect((await as(OUTSIDER)('GET', `/documents/${driveId}`)).status).toBe(200);
  });

  it('creating a project document needs an existing project', async () => {
    expect((await asScopeAll()('POST', '/project-documents/prj_does_not_exist', { name: 'Ghost' })).status).toBe(404);
  });
});

describe('project messages (TASK-792, TASK-864)', () => {
  const messagePost = async (send: Send, message: string) =>
    (await json<{ data: { id: string } }>(await send('POST', '/project-messages', { projectId: P1, message }))).data.id;

  it('a member can delete their own message without projects:delete', async () => {
    const send = as(MEMBER);
    const id = await messagePost(send, 'mine');
    expect((await send('DELETE', `/project-messages/${id}`)).status).toBe(204);
  });

  it('a member cannot delete somebody else\'s message, a project admin can', async () => {
    const id = await messagePost(as(MEMBER), 'moderate me');
    expect((await as(VIEWER)('DELETE', `/project-messages/${id}`)).status).toBe(403);
    expect((await as(ADMIN)('DELETE', `/project-messages/${id}`)).status).toBe(204);
  });

  it('a removed member can no longer edit or delete their old messages', async () => {
    const LEAVER = 'user_h_leaver';
    await seedWorkspaceMember(LEAVER, 'Lea Leaver');
    await seedMember(P1, LEAVER, 'member');
    const own = await messagePost(as(LEAVER), 'before leaving');
    await db
      .update(schema.projectMembers)
      .set({ isActive: false, deletedAt: new Date() })
      .where(eq(schema.projectMembers.id, `pm_${P1}_${LEAVER}`));
    expect((await as(LEAVER)('PATCH', `/project-messages/${own}`, { message: 'edited' })).status).toBe(403);
    expect((await as(LEAVER)('DELETE', `/project-messages/${own}`)).status).toBe(403);
  });

  it('a member demoted to viewer can no longer edit their message', async () => {
    const DEMOTED = 'user_h_demoted';
    await seedWorkspaceMember(DEMOTED, 'Dee Demoted');
    await seedMember(P1, DEMOTED, 'member');
    const own = await messagePost(as(DEMOTED), 'hello');
    await db
      .update(schema.projectMembers)
      .set({ role: 'viewer' })
      .where(eq(schema.projectMembers.id, `pm_${P1}_${DEMOTED}`));
    expect((await as(DEMOTED)('PATCH', `/project-messages/${own}`, { message: 'edit' })).status).toBe(403);
    // Deleting their own old message stays possible while they can still see the project.
    expect((await as(DEMOTED)('DELETE', `/project-messages/${own}`)).status).toBe(204);
  });
});

describe('workload overview (TASK-791)', () => {
  const W1 = 'prj_wl_one';
  const W2 = 'prj_wl_two';
  const SPLIT = 'user_wl_split';
  const BYSTANDER_ADMIN = 'user_wl_admin';

  beforeAll(async () => {
    await seedProject(W1, 'user_wl_manager');
    await seedProject(W2, 'user_wl_manager');
    await seedWorkspaceMember(SPLIT, 'Sam Split', { hoursPerWeek: '40' });
    await seedWorkspaceMember(BYSTANDER_ADMIN, 'Bea Bystander');
    await seedMember(W1, SPLIT, 'member', { allocationPercentage: '50' });
    await seedMember(W2, SPLIT, 'member', { allocationPercentage: '50' });
    await seedTask(W1, 'Split work A', { assigneeId: SPLIT, number: 9001 });
    await seedTask(W2, 'Split work B', { assigneeId: SPLIT, number: 9002 });
    await seedTask(W1, 'Nobody owns this');
    await seedTask(W1, 'Done work', { assigneeId: SPLIT, status: 'done' });
    await seedTask(W2, 'Assigned to a non-member', { assigneeId: 'user_wl_outsider' });
  });

  it('sums a person\'s allocation across projects and caps it at 100%', async () => {
    const overview = await json<{ data: { teamMembers: Array<{ userId: string; capacity: number; tasks: Array<{ number: number | null }> }> } }>(
      await as(SPLIT)('GET', '/projects/workload/overview'),
    );
    const split = overview.data.teamMembers.find((m) => m.userId === SPLIT);
    expect(split?.capacity).toBe(40);
    expect(split?.tasks.map((t) => t.number).sort()).toEqual([9001, 9002]);
  });

  it('puts unassigned and non-member work in an "unassigned" bucket so the totals add up', async () => {
    const overview = await json<{
      data: {
        totalTasks: number;
        teamMembers: Array<{ tasks: unknown[] }>;
        unassigned: { tasks: Array<{ title: string }> };
      };
    }>(await as(SPLIT)('GET', '/projects/workload/overview'));
    expect(overview.data.unassigned.tasks.map((t) => t.title).sort()).toEqual([
      'Assigned to a non-member',
      'Nobody owns this',
    ]);
    const memberTasks = overview.data.teamMembers.reduce((n, m) => n + m.tasks.length, 0);
    expect(overview.data.totalTasks).toBe(memberTasks + overview.data.unassigned.tasks.length);
  });

  it('a scope:all admin who is on no project still sees the workload', async () => {
    const overview = await json<{ data: { totalProjects: number; teamMembers: Array<{ userId: string }> } }>(
      await as(BYSTANDER_ADMIN, ['projects:scope:all'])('GET', '/projects/workload/overview'),
    );
    expect(overview.data.totalProjects).toBeGreaterThanOrEqual(2);
    expect(overview.data.teamMembers.some((m) => m.userId === SPLIT)).toBe(true);
  });

  it('a user on no project gets an empty workload', async () => {
    const overview = await json<{ data: { totalProjects: number; totalTasks: number; teamMembers: unknown[] } }>(
      await as(OUTSIDER)('GET', '/projects/workload/overview'),
    );
    expect(overview.data).toMatchObject({ totalProjects: 0, totalTasks: 0, teamMembers: [] });
  });
});

describe('All Projects list filters and sorting (TASK-799, TASK-789)', () => {
  const owner1 = 'user_list_owner_a';
  const owner2 = 'user_list_owner_b';

  beforeAll(async () => {
    await seedWorkspaceMember(owner1, 'Alice Alpha');
    await seedWorkspaceMember(owner2, 'Zed Zulu');
    const base = { createdAt: new Date(), updatedAt: new Date() };
    const rows: Array<typeof schema.projects.$inferInsert> = [
      { id: 'prj_ls_a', name: 'Alpha Project', status: 'Active', health: 'at_risk', priority: 'high', endDate: new Date('2031-03-01T00:00:00Z'), ...base },
      { id: 'prj_ls_b', name: 'beta project', status: 'Active', health: null, priority: null, endDate: new Date('2031-01-01T00:00:00Z'), ...base },
      { id: 'prj_ls_c', name: 'Gamma 50% club', status: 'On Hold', health: null, priority: 'low', endDate: null, ...base },
      { id: 'prj_ls_d', name: 'Delta', status: 'Completed', health: 'on_track', priority: 'critical', endDate: new Date('2031-02-01T00:00:00Z'), ...base },
    ];
    await db.insert(schema.projects).values(rows).onConflictDoNothing();
    await seedMember('prj_ls_a', owner1, 'owner');
    await seedMember('prj_ls_b', owner2, 'owner');
  });

  const ids = async (query: string) =>
    (await json<{ data: Array<{ id: string }> }>(await asScopeAll()('GET', `/projects?${query}`))).data
      .map((p) => p.id)
      .filter((id) => id.startsWith('prj_ls_'));

  it('status filters on the status the table shows (health first, else the stored status)', async () => {
    expect(await ids('status=at-risk')).toEqual(['prj_ls_a']);
    expect((await ids('status=on-track')).sort()).toEqual(['prj_ls_b', 'prj_ls_d']);
    expect(await ids('status=on-hold')).toEqual(['prj_ls_c']);
    // Stored spellings keep working.
    expect((await ids('status=Active')).sort()).toEqual(['prj_ls_a', 'prj_ls_b']);
  });

  it('priority filters, and an unset priority counts as medium', async () => {
    expect(await ids('priority=high')).toEqual(['prj_ls_a']);
    expect(await ids('priority=medium')).toEqual(['prj_ls_b']);
  });

  it('ownerId filters on the owner', async () => {
    expect(await ids(`ownerId=${owner1}`)).toEqual(['prj_ls_a']);
    expect(await ids(`ownerId=${owner2}`)).toEqual(['prj_ls_b']);
  });

  it('search is case-insensitive and % is literal', async () => {
    expect((await ids('search=ALPHA')).sort()).toEqual(['prj_ls_a']);
    expect(await ids('search=BETA')).toEqual(['prj_ls_b']);
    expect(await ids('search=%25')).toEqual(['prj_ls_c']);
  });

  it('sorts by name, priority, due date (nulls last) and owner, and pages sorted lists by offset', async () => {
    expect(await ids('sortField=name&sortDirection=asc')).toEqual(['prj_ls_a', 'prj_ls_b', 'prj_ls_d', 'prj_ls_c']);
    expect(await ids('sortField=priority&sortDirection=desc')).toEqual(['prj_ls_d', 'prj_ls_a', 'prj_ls_b', 'prj_ls_c']);
    expect(await ids('sortField=dueDate&sortDirection=asc')).toEqual(['prj_ls_b', 'prj_ls_d', 'prj_ls_a', 'prj_ls_c']);
    const byOwner = await ids('sortField=owner&sortDirection=asc');
    expect(byOwner.indexOf('prj_ls_a')).toBeLessThan(byOwner.indexOf('prj_ls_b'));

    const page1 = await json<{ data: Array<{ id: string }>; pagination: { cursor: string | null; hasMore: boolean } }>(
      await asScopeAll()('GET', '/projects?sortField=name&sortDirection=asc&search=project&limit=1'),
    );
    expect(page1.data.map((p) => p.id)).toEqual(['prj_ls_a']);
    expect(page1.pagination.hasMore).toBe(true);
    const page2 = await json<{ data: Array<{ id: string }> }>(
      await asScopeAll()('GET', `/projects?sortField=name&sortDirection=asc&search=project&limit=1&cursor=${page1.pagination.cursor}`),
    );
    expect(page2.data.map((p) => p.id)).toEqual(['prj_ls_b']);
  });
});

describe('whiteboards of a deleted project are hidden from scope:all lists', () => {
  it('listing without a projectId skips deleted projects', async () => {
    await seedProject('prj_wb_dead', MANAGER, { deletedAt: new Date() });
    await db
      .insert(schema.projectWhiteboards)
      .values({ id: 'pwb_dead', projectId: 'prj_wb_dead', name: 'Dead board', elements: [], createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    const list = await json<{ data: Array<{ id: string }> }>(await asScopeAll()('GET', '/whiteboards'));
    expect(list.data.some((b) => b.id === 'pwb_dead')).toBe(false);
  });
});

describe('project member reads', () => {
  it('lists the users who could join, reads a member by row id and the stats placeholder', async () => {
    const send = as(OWNER);
    const available = await send('GET', `/project-members/available?projectId=${P1}`);
    expect(available.status).toBe(200);
    const ids = (await json<{ data: Array<{ id?: string; userId?: string }> }>(available)).data.map(
      (user) => user.userId ?? user.id,
    );
    expect(ids).toContain(OUTSIDER);
    expect(ids).not.toContain(MEMBER);

    const row = await send('GET', `/project-members/pm_${P1}_${MEMBER}`);
    expect(row.status).toBe(200);
    expect((await as(OUTSIDER)('GET', `/project-members/pm_${P1}_${MEMBER}`)).status).toBe(403);
    expect((await send('GET', `/project-members/by-user/${P1}/${MEMBER}/stats`)).status).toBe(200);
  });
});

describe('a tour of the project resources', () => {
  const importEnv = {
    STORAGE: createMemoryR2(),
    IMPORT_TASKS: { create: async ({ id }: { id: string }) => ({ id }) },
  } as unknown as Partial<Env>;
  const withImports = (userId: string): Send => {
    const { request } = createTestApp('/api', router, {
      context: {
        userId,
        permissions: permissions(...MEMBER_PERMISSIONS, 'tasks:create'),
        tenantDb: db,
        flags: flagsOn,
      },
      env: importEnv,
    });
    return (method, path, body) =>
      request(`/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  };
  const idOf = async (res: Response) => {
    expect(res.status).toBeLessThan(300);
    return (await json<{ data: { id: string } }>(res)).data.id;
  };

  it('reads, creates and removes each resource of a project as its owner', async () => {
    const send = as(OWNER);
    const ok = async (method: string, path: string, body?: unknown) => {
      const res = await send(method, path, body);
      expect(res.status, `${method} ${path}`).toBeLessThan(300);
      return res;
    };
    await seedTask(P1, 'Tour task', { startDate: new Date('2026-05-01T09:00:00.000Z') });

    await ok('GET', '/projects/search?q=Project');
    await ok('GET', `/projects/${P1}/gantt/tasks`);
    await ok('GET', `/projects/${P1}/gantt/milestones`);
    await ok('GET', `/project-documents/${P1}`);

    const milestone = await idOf(
      await send('POST', '/milestones', { name: 'Tour milestone', projectId: P1, dueDate: '2030-01-01T00:00:00.000Z' }),
    );
    await ok('GET', `/milestones?projectId=${P1}`);
    await ok('GET', `/milestones/${milestone}`);
    expect((await send('DELETE', `/milestones/${milestone}`)).status).toBe(204);

    const sprint = await idOf(await send('POST', '/sprints', { name: 'Tour sprint', projectId: P1 }));
    await ok('GET', `/sprints?projectId=${P1}`);
    await ok('GET', `/sprints/${sprint}`);
    expect((await send('DELETE', `/sprints/${sprint}`)).status).toBe(403);
    expect((await asScopeAll()('DELETE', `/sprints/${sprint}`)).status).toBe(204);

    const message = await idOf(await send('POST', '/project-messages', { projectId: P1, message: 'Tour message' }));
    await ok('GET', `/project-messages?projectId=${P1}`);
    await ok('GET', `/project-messages/${message}`);
    await ok('POST', `/project-messages/${message}/reactions`, { emoji: '👍' });

    const board = await idOf(await send('POST', '/whiteboards', { projectId: P1, name: 'Tour board' }));
    await ok('GET', `/whiteboards/${board}`);
    await ok('PATCH', `/whiteboards/${board}`, { name: 'Tour board, renamed' });
    expect((await send('DELETE', `/whiteboards/${board}`)).status).toBe(403);
    expect((await asScopeAll()('DELETE', `/whiteboards/${board}`)).status).toBe(204);

    const started = await withImports(OWNER)('POST', `/projects/${P1}/tasks/import-jobs`, {
      tasks: [{ title: 'Imported' }],
    });
    expect(started.status).toBe(201);
    const { data } = await json<{ data: { jobId: string } }>(started);
    expect((await withImports(OWNER)('GET', `/projects/${P1}/tasks/import-jobs/${data.jobId}`)).status).toBe(200);

    const doomed = await idOf(await send('POST', '/projects', { name: 'Doomed project' }));
    expect((await send('DELETE', `/projects/${doomed}`)).status).toBe(403);
    expect((await asScopeAll()('DELETE', `/projects/${doomed}`)).status).toBe(204);
  });
});
