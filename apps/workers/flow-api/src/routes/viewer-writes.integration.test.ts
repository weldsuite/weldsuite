/**
 * DB-backed integration tests for the project 'viewer' role (TASK-764).
 *
 * `canAccessProject` lets any active member through, viewers included, so the
 * mutation handlers used to accept writes from viewers. Mutations now go through
 * `canWriteProject` / `canWriteTaskProject`, which apply the same rule as
 * `GET /api/projects/:id/permissions`:
 *   admin  = scope:all, project manager, or an owner/admin member
 *   write  = admin, or a 'member' role (case-insensitive)
 *   read   = write, or a 'viewer' role
 *
 * None of the callers here hold `projects:scope:all` unless a case says so, which
 * is what the older route tests use and why they never saw the gap.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';
import { tasksRoutes } from './tasks';
import { projectsRoutes } from './projects';
import { taskCommentsRoutes } from './task-comments';
import { sprintsRoutes } from './sprints';
import { milestonesRoutes } from './milestones';
import { goalsRoutes } from './goals';
import { whiteboardsRoutes } from './whiteboards';
import { projectFilesRoutes } from './project-files';
import { projectMessagesRoutes } from './project-messages';
import { projectPipelineStagesRoutes } from './project-pipeline-stages';
import { projectLabelsRoutes } from './project-labels';
import { projectDocumentsRoutes } from './project-documents';
import { projectSheetsRoutes } from './project-sheets';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/tasks', tasksRoutes);
router.route('/projects', projectsRoutes);
router.route('/task-comments', taskCommentsRoutes);
router.route('/sprints', sprintsRoutes);
router.route('/milestones', milestonesRoutes);
router.route('/goals', goalsRoutes);
router.route('/whiteboards', whiteboardsRoutes);
router.route('/project-files', projectFilesRoutes);
router.route('/project-messages', projectMessagesRoutes);
router.route('/project-pipeline-stages', projectPipelineStagesRoutes);
router.route('/project-labels', projectLabelsRoutes);
router.route('/project-documents', projectDocumentsRoutes);
router.route('/project-sheets', projectSheetsRoutes);

// The feature-level grants a plain member of the workspace holds. No scope:all.
const FEATURE_PERMISSIONS = [
  'tasks:read',
  'tasks:create',
  'tasks:update',
  'tasks:delete',
  'projects:read',
  'projects:create',
  'projects:update',
  'projects:delete',
  'milestones:read',
  'milestones:create',
  'milestones:update',
  'milestones:delete',
  'files:read',
  'files:create',
  'files:update',
  'files:delete',
];

const flagsOn = { isOn: async () => true } as unknown as NonNullable<Variables['flags']>;

const PROJECT = 'prj_vw';
const OTHER_PROJECT = 'prj_vw_other';
const MANAGER = 'user_manager';
const SCOPE_ALL = 'user_scope_all';

const VIEWER = 'user_viewer';
const MEMBER = 'user_member';
const MIXED_CASE_MEMBER = 'user_member_mixed';
const ADMIN = 'user_admin';
const OWNER = 'user_owner';
const OUTSIDER = 'user_outsider';

let db: Database;

type Send = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<Response>;

function as(userId: string, extraPermissions: string[] = []): Send {
  const { request } = createTestApp('/api', router, {
    context: {
      userId,
      permissions: permissions(...FEATURE_PERMISSIONS, ...extraPermissions),
      tenantDb: db,
      flags: flagsOn,
    },
  });
  return async (method, path, body) =>
    request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const asScopeAll = () => as(SCOPE_ALL, ['projects:scope:all']);

async function seedProject(id: string, managerId: string) {
  const now = new Date();
  await db
    .insert(schema.projects)
    .values({
      id,
      name: `Project ${id}`,
      projectManagerId: managerId,
      createdAt: now,
      updatedAt: now,
    } as typeof schema.projects.$inferInsert)
    .onConflictDoNothing();
}

async function seedMember(projectId: string, userId: string, role: string) {
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
    } as typeof schema.projectMembers.$inferInsert)
    .onConflictDoNothing();
}

async function idOf(res: Response): Promise<string> {
  expect(res.status).toBeLessThan(300);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

async function createTask(send: Send, title: string, projectId: string | null = PROJECT) {
  return idOf(await send('POST', '/tasks', projectId ? { title, projectId } : { title }));
}

async function taskRow(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return row;
}

// Fixtures created through the API by a scope:all caller, so each id is real.
const fixtures = {
  sprintId: '',
  milestoneId: '',
  goalId: '',
  whiteboardId: '',
  folderId: '',
  messageId: '',
  stageId: '',
  labelId: '',
};

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedProject(PROJECT, MANAGER);
  await seedProject(OTHER_PROJECT, MANAGER);
  await seedMember(PROJECT, VIEWER, 'viewer');
  await seedMember(PROJECT, MEMBER, 'member');
  await seedMember(PROJECT, MIXED_CASE_MEMBER, 'Member');
  await seedMember(PROJECT, ADMIN, 'admin');
  await seedMember(PROJECT, OWNER, 'owner');
  // The member of PROJECT is only a viewer of OTHER_PROJECT.
  await seedMember(OTHER_PROJECT, MEMBER, 'viewer');

  const root = asScopeAll();
  fixtures.sprintId = await idOf(await root('POST', '/sprints', { name: 'Sprint', projectId: PROJECT }));
  fixtures.milestoneId = await idOf(
    await root('POST', '/milestones', {
      name: 'Milestone',
      projectId: PROJECT,
      dueDate: '2030-01-01T00:00:00.000Z',
    }),
  );
  fixtures.goalId = await idOf(await root('POST', '/goals', { name: 'Goal', projectId: PROJECT }));
  fixtures.whiteboardId = await idOf(
    await root('POST', '/whiteboards', { projectId: PROJECT, name: 'Board' }),
  );
  fixtures.folderId = await idOf(
    await root('POST', '/project-files/folders', { projectId: PROJECT, name: 'Folder' }),
  );
  fixtures.messageId = await idOf(
    await root('POST', '/project-messages', { projectId: PROJECT, message: 'Hello' }),
  );
  fixtures.stageId = await idOf(
    await root('POST', '/project-pipeline-stages', { projectId: PROJECT, name: 'Stage' }),
  );
  fixtures.labelId = await idOf(
    await root('POST', '/project-labels', { name: 'Label', color: '#ff0000', projectId: PROJECT }),
  );
}, 60_000);

describe('project viewer · writes are rejected', () => {
  it('task create in a project', async () => {
    const res = await as(VIEWER)('POST', '/tasks', { title: 'Nope', projectId: PROJECT });
    expect(res.status).toBe(403);
    const res2 = await as(VIEWER)('POST', `/tasks/projects/${PROJECT}`, { title: 'Nope' });
    expect(res2.status).toBe(403);
  });

  it('task PATCH, status, toggle, position, dependencies', async () => {
    const id = await createTask(asScopeAll(), 'Viewer target');
    const send = as(VIEWER);
    expect((await send('PATCH', `/tasks/${id}`, { title: 'Renamed' })).status).toBe(403);
    expect((await send('PATCH', `/tasks/${id}/status`, { status: 'done' })).status).toBe(403);
    expect((await send('PATCH', `/tasks/${id}/toggle`, {})).status).toBe(403);
    expect((await send('PATCH', `/tasks/${id}/position`, { position: 3 })).status).toBe(403);
    expect((await send('PUT', `/tasks/${id}/dependencies`, { dependsOn: [] })).status).toBe(403);
    expect((await send('PATCH', '/tasks/reorder', { taskIds: [id] })).status).toBe(403);
    expect(
      (await send('PATCH', `/tasks/reorder?projectId=${PROJECT}`, { taskIds: [id] })).status,
    ).toBe(403);

    const row = await taskRow(id);
    expect(row?.title).toBe('Viewer target');
    expect(row?.status).not.toBe('done');
  });

  it('task move (source or destination)', async () => {
    const id = await createTask(asScopeAll(), 'Move target');
    // Viewer of the source project.
    expect((await as(VIEWER)('POST', `/tasks/${id}/move`, { projectId: OTHER_PROJECT })).status).toBe(
      403,
    );
    // Writer on the source but only a viewer of the destination.
    expect((await as(MEMBER)('POST', `/tasks/${id}/move`, { projectId: OTHER_PROJECT })).status).toBe(
      403,
    );
    expect((await taskRow(id))?.projectId).toBe(PROJECT);
  });

  it('task attachments', async () => {
    const id = await createTask(asScopeAll(), 'Attachment target');
    const send = as(VIEWER);
    const add = await send('POST', `/tasks/${id}/attachments`, {
      fileName: 'a.txt',
      fileKey: 'k/a.txt',
      mimeType: 'text/plain',
      fileSize: 1,
    });
    expect(add.status).toBe(403);
    expect((await send('DELETE', `/tasks/${id}/attachments/file_x`)).status).toBe(403);
  });

  it('task DELETE', async () => {
    const id = await createTask(asScopeAll(), 'Delete target');
    expect((await as(VIEWER)('DELETE', `/tasks/${id}`)).status).toBe(403);
    expect((await taskRow(id))?.deletedAt).toBeNull();
  });

  it('task import-jobs', async () => {
    const res = await as(VIEWER)('POST', `/projects/${PROJECT}/tasks/import-jobs`, {
      tasks: [{ title: 'Imported' }],
    });
    expect(res.status).toBe(403);
  });

  it('task comment create', async () => {
    const id = await createTask(asScopeAll(), 'Comment target');
    const res = await as(VIEWER)('POST', '/task-comments', { taskId: id, content: 'Hi' });
    expect(res.status).toBe(403);
  });

  it('sprint create / patch / delete', async () => {
    const send = as(VIEWER);
    expect((await send('POST', '/sprints', { name: 'S', projectId: PROJECT })).status).toBe(403);
    expect((await send('PATCH', `/sprints/${fixtures.sprintId}`, { name: 'X' })).status).toBe(403);
    expect((await send('DELETE', `/sprints/${fixtures.sprintId}`)).status).toBe(403);
  });

  it('milestone create / patch / delete', async () => {
    const send = as(VIEWER);
    const created = await send('POST', '/milestones', {
      name: 'M',
      projectId: PROJECT,
      dueDate: '2030-02-01T00:00:00.000Z',
    });
    expect(created.status).toBe(403);
    expect((await send('PATCH', `/milestones/${fixtures.milestoneId}`, { name: 'X' })).status).toBe(
      403,
    );
    expect((await send('DELETE', `/milestones/${fixtures.milestoneId}`)).status).toBe(403);
  });

  it('goal canvas save / create / patch / delete', async () => {
    const send = as(VIEWER);
    expect((await send('PUT', `/goals/by-project/${PROJECT}`, { goals: [] })).status).toBe(403);
    expect((await send('POST', '/goals', { name: 'G', projectId: PROJECT })).status).toBe(403);
    expect((await send('PATCH', `/goals/${fixtures.goalId}`, { name: 'X' })).status).toBe(403);
    expect((await send('DELETE', `/goals/${fixtures.goalId}`)).status).toBe(403);
  });

  it('whiteboard create / patch / delete', async () => {
    const send = as(VIEWER);
    expect((await send('POST', '/whiteboards', { projectId: PROJECT, name: 'B' })).status).toBe(403);
    expect(
      (await send('PATCH', `/whiteboards/${fixtures.whiteboardId}`, { name: 'X' })).status,
    ).toBe(403);
    expect((await send('DELETE', `/whiteboards/${fixtures.whiteboardId}`)).status).toBe(403);
  });

  it('project file and folder create / patch / delete', async () => {
    const send = as(VIEWER);
    const folder = await send('POST', '/project-files/folders', { projectId: PROJECT, name: 'F' });
    expect(folder.status).toBe(403);
    const file = await send('POST', '/project-files', { projectId: PROJECT, fileName: 'a.txt' });
    expect(file.status).toBe(403);
    expect(
      (await send('PATCH', `/project-files/${fixtures.folderId}`, { fileName: 'X' })).status,
    ).toBe(403);
    expect((await send('DELETE', `/project-files/${fixtures.folderId}`)).status).toBe(403);
  });

  it('project message create and reaction', async () => {
    const send = as(VIEWER);
    expect(
      (await send('POST', '/project-messages', { projectId: PROJECT, message: 'Hi' })).status,
    ).toBe(403);
    expect(
      (await send('POST', `/project-messages/${fixtures.messageId}/reactions`, { emoji: 'x' })).status,
    ).toBe(403);
  });

  it('pipeline stage create / reorder / patch / delete', async () => {
    const send = as(VIEWER);
    expect(
      (await send('POST', '/project-pipeline-stages', { projectId: PROJECT, name: 'S' })).status,
    ).toBe(403);
    expect(
      (await send('PATCH', '/project-pipeline-stages/reorder', { stageIds: [fixtures.stageId] }))
        .status,
    ).toBe(403);
    expect(
      (await send('PATCH', `/project-pipeline-stages/${fixtures.stageId}`, { name: 'X' })).status,
    ).toBe(403);
    expect((await send('DELETE', `/project-pipeline-stages/${fixtures.stageId}`)).status).toBe(403);
  });

  it('project-scoped label create / patch / delete', async () => {
    const send = as(VIEWER);
    expect(
      (await send('POST', '/project-labels', { name: 'L', color: '#ff0000', projectId: PROJECT })).status,
    ).toBe(403);
    expect((await send('PATCH', `/project-labels/${fixtures.labelId}`, { name: 'X' })).status).toBe(
      403,
    );
    expect((await send('DELETE', `/project-labels/${fixtures.labelId}`)).status).toBe(403);
  });

  it('project document and sheet create', async () => {
    const send = as(VIEWER);
    expect((await send('POST', `/project-documents/${PROJECT}`, { name: 'Doc' })).status).toBe(403);
    expect((await send('POST', `/project-sheets/${PROJECT}`, { name: 'Sheet' })).status).toBe(403);
  });
});

describe('project viewer · reads and personal work still succeed', () => {
  it('lists and fetches project tasks', async () => {
    const id = await createTask(asScopeAll(), 'Readable task');
    const send = as(VIEWER);
    const listRes = await send('GET', `/tasks?projectId=${PROJECT}`);
    expect(listRes.status).toBe(200);
    expect((await send('GET', `/tasks/${id}`)).status).toBe(200);
  });

  it('reads project sub-resources and documents', async () => {
    const send = as(VIEWER);
    expect((await send('GET', `/sprints/${fixtures.sprintId}`)).status).toBe(200);
    expect((await send('GET', `/milestones?projectId=${PROJECT}`)).status).toBe(200);
    expect((await send('GET', `/goals/by-project/${PROJECT}`)).status).toBe(200);
    expect((await send('GET', `/project-documents/${PROJECT}`)).status).toBe(200);
    expect((await send('GET', `/project-sheets/${PROJECT}`)).status).toBe(200);
  });

  it('can still create and edit a personal task (no project)', async () => {
    const send = as(VIEWER);
    const id = await createTask(send, 'My own task', null);
    expect((await send('PATCH', `/tasks/${id}`, { title: 'Renamed' })).status).toBe(200);
    expect((await taskRow(id))?.title).toBe('Renamed');
  });

  it('can add a workspace-wide label (null projectId stays permission-only)', async () => {
    const res = await as(VIEWER)('POST', '/project-labels', { name: 'Workspace label', color: '#ff0000' });
    expect(res.status).toBe(201);
  });
});

describe('project writers · writes succeed', () => {
  const writers: Array<[string, string, string[]]> = [
    ['member', MEMBER, []],
    ["mixed-case 'Member' role", MIXED_CASE_MEMBER, []],
    ['admin', ADMIN, []],
    ['owner', OWNER, []],
    ['project manager without a member row', MANAGER, []],
    ['projects:scope:all caller who is not a member', SCOPE_ALL, ['projects:scope:all']],
  ];

  it.each(writers)('%s can create and edit project work', async (_label, userId, extra) => {
    const send = as(userId, extra);

    const taskId = await createTask(send, `Task by ${userId}`);
    expect((await send('PATCH', `/tasks/${taskId}`, { title: 'Edited' })).status).toBe(200);
    expect((await send('PATCH', `/tasks/${taskId}/status`, { status: 'in_progress' })).status).toBe(
      200,
    );

    const sprint = await send('POST', '/sprints', { name: 'S', projectId: PROJECT });
    expect(sprint.status).toBe(201);
    const milestone = await send('POST', '/milestones', {
      name: 'M',
      projectId: PROJECT,
      dueDate: '2030-03-01T00:00:00.000Z',
    });
    expect(milestone.status).toBe(201);
    expect(
      (await send('POST', '/project-labels', { name: 'L', color: '#ff0000', projectId: PROJECT })).status,
    ).toBe(201);
    expect((await send('POST', '/task-comments', { taskId, content: 'Hi' })).status).toBe(201);
    expect(
      (await send('POST', '/project-messages', { projectId: PROJECT, message: 'Hi' })).status,
    ).toBe(201);

    expect((await send('DELETE', `/tasks/${taskId}`)).status).toBe(204);
  });

  it('a member can move a task between two projects they can write to', async () => {
    await seedMember(OTHER_PROJECT, ADMIN, 'member');
    const send = as(ADMIN);
    const id = await createTask(send, 'Mover');
    const res = await send('POST', `/tasks/${id}/move`, { projectId: OTHER_PROJECT });
    expect(res.status).toBe(200);
    expect((await taskRow(id))?.projectId).toBe(OTHER_PROJECT);
  });

  it('import-jobs lets a member through the guard', async () => {
    const res = await as(MEMBER)('POST', `/projects/${PROJECT}/tasks/import-jobs`, {
      tasks: [{ title: 'Imported' }],
    });
    // The test env has no R2 / workflow binding, so the handler stops after the guard.
    expect(res.status).not.toBe(403);
  });

  it('project documents and sheets can be created by a member', async () => {
    const send = as(MEMBER);
    expect((await send('POST', `/project-documents/${PROJECT}`, { name: 'Doc' })).status).toBe(201);
    expect((await send('POST', `/project-sheets/${PROJECT}`, { name: 'Sheet' })).status).toBe(201);
  });
});

describe('GET /api/projects/:id/permissions agrees with the guard', () => {
  const cases: Array<[string, string, boolean]> = [
    ['viewer', VIEWER, false],
    ['member', MEMBER, true],
    ["mixed-case 'Member'", MIXED_CASE_MEMBER, true],
    ['admin', ADMIN, true],
    ['owner', OWNER, true],
    ['project manager', MANAGER, true],
  ];

  it.each(cases)('%s', async (_label, userId, expectedCanWrite) => {
    const send = as(userId);
    const permsRes = await send('GET', `/projects/${PROJECT}/permissions`);
    expect(permsRes.status).toBe(200);
    const body = (await permsRes.json()) as { data: { canWrite: boolean; canRead: boolean } };
    expect(body.data.canWrite).toBe(expectedCanWrite);
    expect(body.data.canRead).toBe(true);

    // The guard must give the same answer as the flag the UI reads.
    const write = await send('POST', '/sprints', { name: 'Parity', projectId: PROJECT });
    expect(write.status === 403).toBe(!body.data.canWrite);
  });

  it('scope:all caller gets canWrite and isAdmin', async () => {
    const res = await asScopeAll()('GET', `/projects/${PROJECT}/permissions`);
    const body = (await res.json()) as { data: { canWrite: boolean; isAdmin: boolean } };
    expect(body.data.canWrite).toBe(true);
    expect(body.data.isAdmin).toBe(true);
  });

  it('a non-member has no access', async () => {
    const res = await as(OUTSIDER)('GET', `/projects/${PROJECT}/permissions`);
    const body = (await res.json()) as { data: { canWrite: boolean; canRead: boolean; role: null } };
    expect(body.data).toMatchObject({ canWrite: false, canRead: false, role: null });
  });
});

describe('non-members stay locked out', () => {
  it('project documents and sheets reads are denied', async () => {
    const send = as(OUTSIDER);
    expect((await send('GET', `/project-documents/${PROJECT}`)).status).toBe(403);
    expect((await send('GET', `/project-sheets/${PROJECT}`)).status).toBe(403);
  });

  it('project writes are denied', async () => {
    const send = as(OUTSIDER);
    expect((await send('POST', '/tasks', { title: 'x', projectId: PROJECT })).status).toBe(403);
    expect((await send('POST', `/project-documents/${PROJECT}`, { name: 'Doc' })).status).toBe(403);
    expect((await send('POST', '/project-labels', { name: 'L', color: '#ff0000', projectId: PROJECT })).status).toBe(
      403,
    );
  });
});
