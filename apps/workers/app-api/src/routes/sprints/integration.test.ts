/**
 * DB-backed integration tests for /api/sprints.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { sprintsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedProject(): Promise<string> {
  const id = generateId('prj');
  const now = new Date();
  await db
    .insert(schema.projects)
    .values({ id, name: 'Sprint Test Parent', createdAt: now, updatedAt: now });
  return id;
}

describe('/api/sprints · pglite integration', () => {
  it('POST / writes a sprint tied to a seeded project', async () => {
    const projectId = await seedProject();
    const { request } = createTestApp('/api/sprints', sprintsRoutes, {
      context: { permissions: permissions('projects:create'), tenantDb: db },
    });

    const res = await request('/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Sprint 1',
        projectId,
        goal: 'Ship the test suite',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^spr_/);

    const [row] = await db
      .select()
      .from(schema.sprints)
      .where(eq(schema.sprints.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Sprint 1');
    expect(row?.projectId).toBe(projectId);
  });

  it('POST / returns 400 with missing projectId', async () => {
    const { request } = createTestApp('/api/sprints', sprintsRoutes, {
      context: { permissions: permissions('projects:create'), tenantDb: db },
    });
    const res = await request('/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lonely Sprint' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/projectId/);
  });
});
