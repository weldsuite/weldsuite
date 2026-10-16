/**
 * Hardening for the personal /api/task-tags and /api/task-projects surfaces
 * (TASK-769 allow-lists, TASK-789 case-insensitive search, TASK-793 `?limit=abc`).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskTagsRoutes } from './index';
import { taskProjectsRoutes } from '../task-projects';
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
}, 60_000);

const json = { 'Content-Type': 'application/json' };
const ME = 'user_hardening';
const allPermissions = permissions('tasks:read', 'tasks:create', 'tasks:update', 'tasks:delete');

const tags = () =>
  createTestApp('/api/task-tags', taskTagsRoutes, {
    context: { permissions: allPermissions, userId: ME, tenantDb: db },
  });
const projects = () =>
  createTestApp('/api/task-projects', taskProjectsRoutes, {
    context: { permissions: allPermissions, userId: ME, tenantDb: db },
  });

describe('/api/task-tags · mass assignment', () => {
  it('POST ignores a client-chosen id and other server-owned columns', async () => {
    const res = await tags().request('/api/task-tags', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        name: 'safe',
        color: '#fff',
        id: 'ttag_chosen',
        userId: 'user_victim',
        deletedAt: '2020-01-01T00:00:00Z',
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(data.id).not.toBe('ttag_chosen');

    const [created] = await db.select().from(schema.taskTags).where(eq(schema.taskTags.id, data.id)).limit(1);
    expect(created?.userId).toBe(ME);
    expect(created?.deletedAt).toBeNull();
    expect(created?.color).toBe('#fff');
    const chosen = await db.select().from(schema.taskTags).where(eq(schema.taskTags.id, 'ttag_chosen'));
    expect(chosen).toEqual([]);
  });

  it('PATCH cannot hand the tag to another user, change its id or delete it', async () => {
    const now = new Date();
    await db.insert(schema.taskTags).values({ id: 'ttag_mine', userId: ME, name: 'mine', createdAt: now, updatedAt: now });

    const res = await tags().request('/api/task-tags/ttag_mine', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({
        name: 'renamed',
        userId: 'user_victim',
        id: 'ttag_other',
        deletedAt: '2020-01-01T00:00:00Z',
      }),
    });
    expect(res.status).toBe(200);

    const [tag] = await db.select().from(schema.taskTags).where(eq(schema.taskTags.id, 'ttag_mine')).limit(1);
    expect(tag?.name).toBe('renamed');
    expect(tag?.userId).toBe(ME);
    expect(tag?.deletedAt).toBeNull();
    expect(await db.select().from(schema.taskTags).where(eq(schema.taskTags.id, 'ttag_other'))).toEqual([]);
  });
});

describe('/api/task-tags · list', () => {
  it('finds a tag case-insensitively and treats % literally', async () => {
    const now = new Date();
    await db.insert(schema.taskTags).values([
      { id: 'ttag_s1', userId: ME, name: 'Acme Corp', createdAt: now, updatedAt: now },
      { id: 'ttag_s2', userId: ME, name: '100% done', createdAt: now, updatedAt: now },
    ]);
    const names = async (search: string) =>
      (
        (await (await tags().request(`/api/task-tags?search=${encodeURIComponent(search)}`)).json()) as {
          data: { name: string }[];
        }
      ).data.map((tag) => tag.name);

    expect(await names('acme')).toEqual(['Acme Corp']);
    expect(await names('%')).toEqual(['100% done']);
  });

  it('answers 200 for a non-numeric limit instead of failing with a 500', async () => {
    const res = await tags().request('/api/task-tags?limit=abc');
    expect(res.status).toBe(200);
    const zero = await tags().request('/api/task-tags?limit=0');
    expect(zero.status).toBe(200);
  });
});

describe('/api/task-projects · mass assignment and list', () => {
  it('POST and PATCH write only the allow-listed fields', async () => {
    const created = await projects().request('/api/task-projects', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'Mine', id: 'tpr_chosen', userId: 'user_victim' }),
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    expect(data.id).not.toBe('tpr_chosen');
    const [row] = await db.select().from(schema.taskProjects).where(eq(schema.taskProjects.id, data.id)).limit(1);
    expect(row?.userId).toBe(ME);

    const patched = await projects().request(`/api/task-projects/${data.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ description: 'd', userId: 'user_victim', deletedAt: '2020-01-01T00:00:00Z' }),
    });
    expect(patched.status).toBe(200);
    const [after] = await db.select().from(schema.taskProjects).where(eq(schema.taskProjects.id, data.id)).limit(1);
    expect(after?.description).toBe('d');
    expect(after?.userId).toBe(ME);
    expect(after?.deletedAt).toBeNull();
  });

  it('searches case-insensitively and survives ?limit=abc', async () => {
    const res = await projects().request('/api/task-projects?search=mine&limit=abc');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string }[] };
    expect(body.data.map((project) => project.name)).toEqual(['Mine']);
  });
});
