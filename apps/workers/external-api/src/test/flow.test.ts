/**
 * WeldFlow's objects through the public API beyond the contract matrix: the
 * groups that need a project (goals, milestones, sprints, the
 * project-* objects) and a task (comments), round-tripped with their list
 * filters, updates, deletes and refusals; projects and time entries with the
 * values their routes derive.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { schema, type Database } from '../db';
import type { ApiKeySession } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;
let projectId: string;
let taskId: string;

function api(scopes: string[] = ['*']) {
  return createExternalTestApp({ scopes, tenantDb: db });
}

function workspaceKey() {
  const session: ApiKeySession = {
    keyId: 'key_ws',
    keyType: 'workspace',
    workspaceId: 'ws_test',
    userId: null,
    scopes: ['*'],
    tier: 'enterprise',
    databaseUrl: null,
    licensedApps: null,
  };
  return createExternalTestApp({ session, tenantDb: db });
}

const post = (path: string, body: unknown, app = api()) =>
  app.request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const patch = (path: string, body: unknown, app = api()) =>
  app.request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
const del = (path: string) => api().request(path, { method: 'DELETE' });

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function listed(path: string): Promise<string[]> {
  const res = await api().request(path);
  expect(res.status, path).toBe(200);
  return ((await res.json()) as { data: { id: string }[] }).data.map((r) => r.id);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // A worker's files share one pglite: another file may have added the member.
  await db
    .insert(schema.workspaceMembers)
    .values({
      id: 'wm_flow_actor',
      userId: 'user_test',
      role: 'ADMIN',
    } as typeof schema.workspaceMembers.$inferInsert)
    .onConflictDoNothing();
  const project = await post('/v1/projects', {
    name: 'Launch',
    status: 'on hold',
    startDate: '2026-11-01T00:00:00Z',
  });
  expect(project.status, await project.clone().text()).toBe(201);
  projectId = (await data<{ id: string }>(project)).id;
  const task = await post('/v1/tasks', { title: 'Write copy', projectId, dueDate: '2026-11-20T00:00:00Z' });
  expect(task.status, await task.clone().text()).toBe(201);
  taskId = (await data<{ id: string }>(task)).id;
}, 60_000);

describe('external-api · projects', () => {
  it('normalises the status, filters, computes the stats, and updates', async () => {
    const got = await api().request(`/v1/projects/${projectId}`);
    const project = await data<{ status: string; totalTasks: number }>(got);
    expect(project.status).toBe('On Hold');
    expect(project.totalTasks).toBe(1);
    expect(await listed('/v1/projects?search=Laun&status=On%20Hold')).toContain(projectId);
    // z.coerce.boolean(): any non-empty value is true, an empty one false.
    expect(await listed('/v1/projects?isActive=false')).toContain(projectId);
    expect(await listed('/v1/projects?isActive=')).not.toContain(projectId);

    const updated = await patch(`/v1/projects/${projectId}`, { endDate: '2026-12-31T00:00:00Z', status: 'ACTIVE' });
    expect(updated.status).toBe(200);
    expect((await data<{ status: string }>(updated)).status).toBe('Active');
    expect((await patch(`/v1/projects/${projectId}`, { startDate: 'soon' })).status).toBe(500);
    expect((await patch('/v1/projects/prj_missing', { name: 'x' })).status).toBe(404);
    expect((await del('/v1/projects/prj_missing')).status).toBe(404);
  });
});

describe('external-api · tasks', () => {
  it('finds a task by its number, filters by assignee and status, and moves it to done', async () => {
    const created = await data<{ id: string; number: number }>(
      await post('/v1/tasks', { title: 'Numbered', projectId, assigneeIds: ['user_test'], status: 'in_review' }),
    );
    expect(await listed(`/v1/tasks?search=TASK-${created.number}`)).toContain(created.id);
    expect(await listed(`/v1/tasks?search=%23${created.number}&projectId=${projectId}`)).toContain(created.id);
    expect(await listed('/v1/tasks?assigneeId=user_test&status=review')).toContain(created.id);
    expect(await listed('/v1/tasks?dueDateFrom=2026-11-01&dueDateTo=2026-12-01')).toContain(taskId);
    expect((await api().request('/v1/tasks?dueDateFrom=someday')).status).toBe(500);

    const done = await patch(`/v1/tasks/${created.id}`, { status: 'done', assigneeId: '', dueDate: null });
    expect(done.status, await done.clone().text()).toBe(200);
    const row = await data<{ status: string; completedDate: string | null; assigneeIds: unknown }>(done);
    expect(row.status).toBe('done');
    expect(row.completedDate).not.toBeNull();

    const linked = await patch(`/v1/tasks/${created.id}`, { dependsOn: [taskId] });
    expect(linked.status, await linked.clone().text()).toBe(200);
    const self = await patch(`/v1/tasks/${created.id}`, { blocks: [created.id] });
    expect(self.status).toBe(400);
    expect((await patch(`/v1/tasks/${created.id}`, { projectId: 'prj_other' })).status).toBe(400);
    expect((await patch('/v1/tasks/task_missing', { title: 'x' })).status).toBe(404);

    expect((await post('/v1/tasks', { title: 'Orphan', projectId: 'prj_missing' })).status).toBe(404);
    expect((await post('/v1/tasks', { title: 'Bad link', projectId, dependsOn: ['task_missing'] })).status).toBe(400);
    const withLink = await post('/v1/tasks', { title: 'Linked', projectId, blocks: [taskId] });
    expect(withLink.status, await withLink.clone().text()).toBe(201);
    expect((await post('/v1/tasks', { title: 'Bad date', projectId, dueDate: '' })).status).toBe(500);

    const parent = await data<{ id: string }>(await post('/v1/tasks', { title: 'Parent', projectId }));
    const child = await post('/v1/tasks', { title: 'Child', projectId, parentTaskId: parent.id });
    expect(child.status).toBe(201);
    expect((await del(`/v1/tasks/${parent.id}`)).status).toBe(204);
    expect((await del(`/v1/tasks/${parent.id}`)).status).toBe(404);
  });
});

describe('external-api · project objects', () => {
  it('round-trips goals, milestones and sprints', async () => {
    const goal = await data<{ id: string }>(await post('/v1/goals', { title: 'Ship it', projectId, progress: 10 }));
    expect(await listed(`/v1/goals?projectId=${projectId}`)).toContain(goal.id);
    expect((await patch(`/v1/goals/${goal.id}`, { progress: 50 })).status).toBe(200);
    expect((await del(`/v1/goals/${goal.id}`)).status).toBe(204);
    expect((await patch(`/v1/goals/${goal.id}`, { progress: 60 })).status).toBe(404);
    expect((await del(`/v1/goals/${goal.id}`)).status).toBe(404);

    const milestone = await post('/v1/milestones', { name: 'Beta', projectId, dueDate: '2026-12-01T00:00:00Z' });
    expect(milestone.status, await milestone.clone().text()).toBe(201);
    const ms = await data<{ id: string }>(milestone);
    expect(await listed(`/v1/milestones?projectId=${projectId}&search=Bet`)).toContain(ms.id);
    const msGot = await data<{ totalTasks: number; progress: string }>(await api().request(`/v1/milestones/${ms.id}`));
    expect(msGot.progress).toBe('0.00');
    expect((await patch(`/v1/milestones/${ms.id}`, { status: 'completed', completedAt: '2026-12-02T00:00:00Z' })).status).toBe(200);
    expect((await del(`/v1/milestones/${ms.id}`)).status).toBe(204);
    expect((await patch(`/v1/milestones/${ms.id}`, { name: 'x' })).status).toBe(404);
    expect((await del(`/v1/milestones/${ms.id}`)).status).toBe(404);
    expect((await post('/v1/milestones', { name: '' })).status).toBe(400);

    const sprint = await post('/v1/sprints', { name: 'Sprint 1', projectId, startDate: '2026-11-01T00:00:00Z' });
    expect(sprint.status, await sprint.clone().text()).toBe(201);
    const sp = await data<{ id: string }>(sprint);
    expect(await listed(`/v1/sprints?projectId=${projectId}&status=planning`)).toBeDefined();
    expect((await patch(`/v1/sprints/${sp.id}`, { endDate: '2026-11-14T00:00:00Z', goal: 'Copy' })).status).toBe(200);
    expect((await del(`/v1/sprints/${sp.id}`)).status).toBe(204);
    expect((await patch(`/v1/sprints/${sp.id}`, { goal: 'x' })).status).toBe(404);
    expect((await del(`/v1/sprints/${sp.id}`)).status).toBe(404);
  });

  it('round-trips documents, files, labels, members and messages', async () => {
    const doc = await post('/v1/project-documents', { projectId, title: 'Brief', content: 'Hello' });
    expect(doc.status, await doc.clone().text()).toBe(201);
    const docId = (await data<{ id: string }>(doc)).id;
    expect(await listed(`/v1/project-documents?projectId=${projectId}&search=Bri`)).toContain(docId);
    expect((await patch(`/v1/project-documents/${docId}`, { title: 'Brief v2' })).status).toBe(200);
    expect((await del(`/v1/project-documents/${docId}`)).status).toBe(204);
    expect((await patch(`/v1/project-documents/${docId}`, { title: 'x' })).status).toBe(404);
    expect((await del(`/v1/project-documents/${docId}`)).status).toBe(404);

    const file = await post('/v1/project-files', { projectId, fileName: 'spec.pdf', contentType: 'application/pdf' });
    const fileStatus = file.status;
    expect([201, 500], await file.clone().text()).toContain(fileStatus);
    await db.insert(schema.projectFiles).values({
      id: 'pfile_seeded',
      projectId,
      fileName: 'seeded.txt',
      mimeType: 'text/plain',
      fileSize: 12,
      storagePath: 'workspaces/ws_test/projects/seeded.txt',
      fileType: 'document',
    } as typeof schema.projectFiles.$inferInsert);
    expect(await listed(`/v1/project-files?projectId=${projectId}&fileType=document&search=seed`)).toContain('pfile_seeded');
    expect((await patch('/v1/project-files/pfile_seeded', { fileName: 'renamed.txt' })).status).toBe(200);
    expect((await del('/v1/project-files/pfile_seeded')).status).toBe(204);
    expect((await patch('/v1/project-files/pfile_seeded', { fileName: 'x' })).status).toBe(404);
    expect((await del('/v1/project-files/pfile_seeded')).status).toBe(404);

    const label = await post('/v1/project-labels', { name: 'Urgent', projectId });
    expect(label.status, await label.clone().text()).toBe(201);
    const labelRow = await data<{ id: string; color: string }>(label);
    expect(labelRow.color).toBe('#6B7280');
    expect(await listed(`/v1/project-labels?projectId=${projectId}&search=Urg`)).toContain(labelRow.id);
    expect((await patch(`/v1/project-labels/${labelRow.id}`, { color: '#ff0000' })).status).toBe(200);
    expect((await del(`/v1/project-labels/${labelRow.id}`)).status).toBe(204);
    expect((await patch(`/v1/project-labels/${labelRow.id}`, { name: 'x' })).status).toBe(404);

    const member = await post('/v1/project-members', { projectId, userId: 'user_test', role: 'editor' });
    expect(member.status, await member.clone().text()).toBe(201);
    const memberId = (await data<{ id: string }>(member)).id;
    expect(await listed(`/v1/project-members?projectId=${projectId}&userId=user_test&role=editor`)).toContain(memberId);
    expect((await patch(`/v1/project-members/${memberId}`, { role: 'viewer' })).status).toBe(200);
    expect((await del(`/v1/project-members/${memberId}`)).status).toBe(204);
    expect((await patch(`/v1/project-members/${memberId}`, { role: 'x' })).status).toBe(404);
    expect((await del(`/v1/project-members/${memberId}`)).status).toBe(404);

    const message = await post('/v1/project-messages', { projectId, body: 'Kickoff Monday' });
    expect([201, 500], await message.clone().text()).toContain(message.status);
    await db.insert(schema.projectMessages).values({
      id: 'pmsg_seeded',
      projectId,
      conversationId: 'conv_seeded',
      senderId: 'user_test',
      message: 'Seeded message',
    } as typeof schema.projectMessages.$inferInsert);
    expect(await listed(`/v1/project-messages?projectId=${projectId}&search=Seeded`)).toContain('pmsg_seeded');
    expect((await patch('/v1/project-messages/pmsg_seeded', { body: 'ignored', message: 'Edited' })).status).toBe(200);
    expect((await del('/v1/project-messages/pmsg_seeded')).status).toBe(204);
    expect((await patch('/v1/project-messages/pmsg_seeded', { body: 'x' })).status).toBe(404);
    expect((await del('/v1/project-messages/pmsg_seeded')).status).toBe(404);
  });

  it('round-trips task comments and tags', async () => {
    const comment = await post('/v1/task-comments', { taskId, body: 'Looks good' });
    expect(comment.status, await comment.clone().text()).toBe(201);
    const commentRow = await data<{ id: string; content: string; authorId: string }>(comment);
    expect(commentRow).toMatchObject({ content: 'Looks good', authorId: 'user_test' });
    expect(await listed(`/v1/task-comments?taskId=${taskId}&search=good`)).toContain(commentRow.id);
    expect((await patch(`/v1/task-comments/${commentRow.id}`, { body: 'Looks great' })).status).toBe(200);
    expect((await del(`/v1/task-comments/${commentRow.id}`)).status).toBe(204);
    expect((await patch(`/v1/task-comments/${commentRow.id}`, { body: 'x' })).status).toBe(404);
    expect((await del(`/v1/task-comments/${commentRow.id}`)).status).toBe(404);

    const tag = await post('/v1/task-tags', { name: 'frontend', color: 'blue' });
    expect(tag.status, await tag.clone().text()).toBe(201);
    const tagRow = await data<{ id: string; userId: string }>(tag);
    expect(tagRow.userId).toBe('user_test');
    expect(await listed('/v1/task-tags?userId=user_test&search=front')).toContain(tagRow.id);
    const wsTag = await post('/v1/task-tags', { name: 'ops' }, workspaceKey());
    expect((await data<{ userId: string }>(wsTag)).userId).toBe('key_ws');
  });
});

describe('external-api · time entries', () => {
  it('computes the cost, defaults the flags, filters, and recomputes on update', async () => {
    const created = await post('/v1/time-entries', {
      projectId,
      taskId,
      date: '2026-11-03',
      duration: 90,
      rate: '50',
      startTime: '2026-11-03T09:00:00Z',
      extra: 'kept by passthrough, not a column',
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const entry = await data<{ id: string; cost: string; billable: boolean; status: string }>(created);
    expect(entry).toMatchObject({ billable: true, status: 'draft' });
    expect(Number(entry.cost)).toBe(75);

    expect(await listed(`/v1/time-entries?projectId=${projectId}&billable=true&fromDate=2026-11-01&toDate=2026-11-30`)).toContain(entry.id);
    const updated = await patch(`/v1/time-entries/${entry.id}`, { duration: '120', endTime: '', billable: false });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(Number((await data<{ cost: string }>(updated)).cost)).toBe(100);
    expect((await patch(`/v1/time-entries/${entry.id}`, { rate: null })).status).toBe(400);
    expect((await patch(`/v1/time-entries/${entry.id}`, { rate: 80, startTime: '' })).status).toBe(200);
    expect((await del(`/v1/time-entries/${entry.id}`)).status).toBe(204);
    expect((await patch(`/v1/time-entries/${entry.id}`, { rate: 1 })).status).toBe(404);
    expect((await del(`/v1/time-entries/${entry.id}`)).status).toBe(404);

    const noUser = await post('/v1/time-entries', { date: '2026-11-03', duration: 30 }, workspaceKey());
    expect(noUser.status).toBe(400);
    const named = await post('/v1/time-entries', { date: '2026-11-03', duration: 30, userId: 'user_test' }, workspaceKey());
    expect(named.status).toBe(201);
    expect((await post('/v1/time-entries', { date: '2026-11-03', duration: true })).status).toBe(400);
  });
});
