/**
 * The personal task lists' routes the other files reach only partly: reading
 * and deleting one's own task project and task tag, paging, and the 404 for
 * someone else's. Runs against the TypeScript worker and, in conformance
 * mode, the Rust backend.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { taskProjectsRoutes } from './index';
import { taskTagsRoutes } from '../task-tags';

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/task-projects', taskProjectsRoutes);
router.route('/task-tags', taskTagsRoutes);

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function as(userId: string) {
  const { request } = createTestApp('/api', router, {
    context: { userId, permissions: permissions('tasks:read', 'tasks:create', 'tasks:update', 'tasks:delete'), tenantDb: db },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe.each(['/task-projects', '/task-tags'])('%s', (base) => {
  it('pages, reads and deletes the caller own rows only', async () => {
    const mine = as('user_pl_owner');
    const first = await mine('POST', base, { name: 'Alpha', color: '#111111' });
    expect(first.status).toBe(201);
    const { id } = ((await first.json()) as { data: { id: string } }).data;
    await mine('POST', base, { name: 'Beta' });

    const page = await mine('GET', `${base}?limit=1`);
    const body = (await page.json()) as { pagination: { cursor: string | null } };
    expect((await mine('GET', `${base}?limit=1&cursor=${body.pagination.cursor}`)).status).toBe(200);
    expect((await mine('GET', `${base}?search=alp&cursor=unknown_row`)).status).toBe(200);
    expect((await mine('GET', `${base}/${id}`)).status).toBe(200);
    expect((await as('user_pl_other')('GET', `${base}/${id}`)).status).toBe(404);
    expect((await as('user_pl_other')('DELETE', `${base}/${id}`)).status).toBe(404);
    expect((await mine('PATCH', `${base}/${id}`, { name: '' })).status).toBe(400);
    expect((await mine('DELETE', `${base}/${id}`)).status).toBe(204);
    expect((await mine('GET', `${base}/${id}`)).status).toBe(404);
  });
});
