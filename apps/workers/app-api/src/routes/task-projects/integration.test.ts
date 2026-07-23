/**
 * DB-backed integration tests for /api/task-projects.
 *
 * Task projects are personal saved-project views. Every read and write is
 * scoped to the calling user: a user must not see or mutate another user's
 * task project.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { taskProjectsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

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

describe('/api/task-projects · pglite integration', () => {
  it('POST / writes a task project scoped to the caller userId', async () => {
    const { request } = createTestApp('/api/task-projects', taskProjectsRoutes, {
      context: {
        permissions: permissions('tasks:create'),
        userId: 'user_owner',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Project View', color: '#0088cc' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^tpr_/);

    const [row] = await db
      .select()
      .from(schema.taskProjects)
      .where(
        and(
          eq(schema.taskProjects.id, body.data.id),
          eq(schema.taskProjects.userId, 'user_owner'),
        ),
      )
      .limit(1);
    expect(row?.name).toBe('My Project View');
    expect(row?.color).toBe('#0088cc');
    expect(row?.userId).toBe('user_owner');
  });

  it('POST / ignores a userId in the body and forces the caller', async () => {
    const { request } = createTestApp('/api/task-projects', taskProjectsRoutes, {
      context: {
        permissions: permissions('tasks:create'),
        userId: 'user_alpha',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Attempt to inject a different userId via the body — must be ignored.
      body: JSON.stringify({ name: 'Sneaky View', userId: 'user_evil' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };

    const [row] = await db
      .select()
      .from(schema.taskProjects)
      .where(eq(schema.taskProjects.id, body.data.id))
      .limit(1);
    expect(row?.userId).toBe('user_alpha');
  });

  it('GET / returns only the caller\'s own task projects', async () => {
    // Seed one entry for user_beta and one for user_gamma.
    const idBeta = 'tpr_beta_own';
    const idGamma = 'tpr_gamma_own';
    const now = new Date();
    await db.insert(schema.taskProjects).values([
      { id: idBeta, userId: 'user_beta', name: 'Beta view', createdAt: now, updatedAt: now },
      { id: idGamma, userId: 'user_gamma', name: 'Gamma view', createdAt: now, updatedAt: now },
    ]);

    const { request } = createTestApp('/api/task-projects', taskProjectsRoutes, {
      context: {
        permissions: permissions('tasks:read'),
        userId: 'user_beta',
        tenantDb: db,
      },
    });

    const res = await request('/api/task-projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(idBeta);
    expect(ids).not.toContain(idGamma);
    for (const row of body.data) {
      expect(row.userId).toBe('user_beta');
    }
  });

  it('GET /:id returns 404 when the entry belongs to a different user', async () => {
    const idOther = 'tpr_other_user';
    const now = new Date();
    await db
      .insert(schema.taskProjects)
      .values({ id: idOther, userId: 'user_delta', name: 'Delta view', createdAt: now, updatedAt: now })
      .onConflictDoNothing();

    const { request } = createTestApp('/api/task-projects', taskProjectsRoutes, {
      context: {
        permissions: permissions('tasks:read'),
        userId: 'user_epsilon',
        tenantDb: db,
      },
    });

    const res = await request(`/api/task-projects/${idOther}`);
    expect(res.status).toBe(404);
  });

  it('PATCH /:id returns 404 when the caller does not own the entry', async () => {
    const idOwned = 'tpr_owned_patch';
    const now = new Date();
    await db
      .insert(schema.taskProjects)
      .values({ id: idOwned, userId: 'user_zeta', name: 'Zeta view', createdAt: now, updatedAt: now })
      .onConflictDoNothing();

    const { request } = createTestApp('/api/task-projects', taskProjectsRoutes, {
      context: {
        permissions: permissions('tasks:update'),
        userId: 'user_eta',
        tenantDb: db,
      },
    });

    const res = await request(`/api/task-projects/${idOwned}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST / rejects a missing name', async () => {
    const { request } = createTestApp('/api/task-projects', taskProjectsRoutes, {
      context: { permissions: permissions('tasks:create'), tenantDb: db },
    });
    const res = await request('/api/task-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#abc' }),
    });
    expect(res.status).toBe(400);
  });
});
