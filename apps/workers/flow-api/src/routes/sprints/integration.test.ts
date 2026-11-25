/**
 * DB-backed integration tests for /api/sprints.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { sprintsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

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
    // scope:all so the project-access boundary isn't what's under test here.
    const { request } = createTestApp('/api/sprints', sprintsRoutes, {
      context: { permissions: permissions('projects:create', 'projects:scope:all'), tenantDb: db },
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

  it("DELETE /:id sends the sprint's tasks back to the backlog", async () => {
    const projectId = await seedProject();
    const now = new Date();
    const sprintId = generateId('spr');
    const otherSprintId = generateId('spr');
    await db.insert(schema.sprints).values([
      { id: sprintId, projectId, name: 'Sprint 9', createdAt: now, updatedAt: now },
      { id: otherSprintId, projectId, name: 'Sprint 10', createdAt: now, updatedAt: now },
    ]);
    const inSprint = generateId('task');
    const elsewhere = generateId('task');
    await db.insert(schema.tasks).values([
      { id: inSprint, title: 'In the sprint', projectId, sprintId },
      { id: elsewhere, title: 'In the next sprint', projectId, sprintId: otherSprintId },
    ] as (typeof schema.tasks.$inferInsert)[]);
    const { request } = createTestApp('/api/sprints', sprintsRoutes, {
      context: { permissions: permissions('projects:delete', 'projects:scope:all'), tenantDb: db },
    });

    const res = await request(`/api/sprints/${sprintId}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    const rows = await db
      .select({ id: schema.tasks.id, sprintId: schema.tasks.sprintId })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, [inSprint, elsewhere]));
    expect(rows.find((row) => row.id === inSprint)?.sprintId).toBeNull();
    expect(rows.find((row) => row.id === elsewhere)?.sprintId).toBe(otherSprintId);
  });
});
