/**
 * DB-backed tests for GET /api/chat-entity-channels/:entityType/:entityId/detail:
 * the record panel next to a record chat, per provider, and its refusals.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { chatEntityChannelsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
const USER = 'user_detail_ann';

function app(...keys: string[]) {
  return createTestApp('/api/chat-entity-channels', chatEntityChannelsRoutes, {
    context: {
      userId: USER,
      permissions: permissions('channels:read', ...keys),
      tenantDb: db,
    },
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date('2026-03-01T10:00:00.000Z');
  await db.insert(schema.projects).values({
    id: 'prj_detail',
    code: 'DET',
    name: 'Detail project',
    projectManagerId: USER,
    budgetedHours: '12.50',
    startDate: now,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.projects.$inferInsert);
  await db.insert(schema.projectMembers).values({
    id: 'pm_detail',
    projectId: 'prj_detail',
    userId: 'user_detail_bob',
    role: 'member',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.projectMembers.$inferInsert);
  await db.insert(schema.tasks).values([
    { id: 'tsk_detail_1', title: 'Done task', status: 'done', projectId: 'prj_detail', createdAt: now, updatedAt: now },
    { id: 'tsk_detail_2', title: 'Open task', status: 'todo', projectId: 'prj_detail', assigneeIds: [USER], tags: ['a'], createdAt: now, updatedAt: now },
  ] as (typeof schema.tasks.$inferInsert)[]);
  await db.insert(schema.hostDomains).values({
    id: 'dom_detail',
    name: 'example',
    tld: 'com',
    fullDomain: 'example.com',
    registrar: 'cloudflare',
    nameservers: ['ns1.example.com'],
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.hostDomains.$inferInsert);
  await db.insert(schema.people).values({
    id: 'per_detail',
    displayName: 'Pat Person',
    firstName: 'Pat',
    lastName: 'Person',
    email: 'pat@example.com',
    ownerId: USER,
    createdAt: now,
    updatedAt: now,
  } as typeof schema.people.$inferInsert);
}, 60_000);

describe('GET /:entityType/:entityId/detail', () => {
  it('answers a project with its computed counters and active members', async () => {
    const res = await app('projects:read').request('/api/chat-entity-channels/project/prj_detail/detail');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { totalTasks: number; completedTasks: number; progress: string; members: unknown[] } };
    expect(data.totalTasks).toBe(2);
    expect(data.completedTasks).toBe(1);
    expect(data.progress).toBe('50.00');
    expect(data.members).toHaveLength(1);
  });

  it('answers a task, a domain (managed registrar shown as WeldSuite) and a legacy contact', async () => {
    const task = await app('tasks:read', 'projects:read').request('/api/chat-entity-channels/task/tsk_detail_2/detail');
    expect(((await task.json()) as { data: { title: string } }).data.title).toBe('Open task');
    const domain = await app('domains:read').request('/api/chat-entity-channels/domain/dom_detail/detail');
    expect(((await domain.json()) as { data: { registrar: string } }).data.registrar).toBe('WeldSuite');
    const contact = await app('people:read').request('/api/chat-entity-channels/contact/per_detail/detail');
    expect(((await contact.json()) as { data: { email: string } }).data.email).toBe('pat@example.com');
  });

  it('refuses a type without a detail, an unknown type and a record the caller may not see', async () => {
    expect((await app('companies:read').request('/api/chat-entity-channels/company/cmp_x/detail')).status).toBe(400);
    expect((await app().request('/api/chat-entity-channels/planet/p1/detail')).status).toBe(400);
    expect((await app().request('/api/chat-entity-channels/project/prj_detail/detail')).status).toBe(403);
    expect((await app('domains:read').request('/api/chat-entity-channels/domain/dom_missing/detail')).status).toBe(403);
  });
});
