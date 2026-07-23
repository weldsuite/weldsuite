/**
 * DB-backed integration tests for /api/milestones.
 *
 * Milestones require a parent project, so the happy-path test seeds
 * one inline. The 400 paths verify the route's defensive checks for
 * `projectId` and `dueDate` (both NOT NULL at the DB layer but
 * optional in Zod for partial-update reuse).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { milestonesRoutes } from './index';
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
    .values({
      id,
      name: 'Milestone Test Parent',
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

describe('/api/milestones · pglite integration', () => {
  it('POST / writes a milestone tied to a seeded project', async () => {
    const projectId = await seedProject();
    const { request } = createTestApp('/api/milestones', milestonesRoutes, {
      context: { permissions: permissions('milestones:create'), tenantDb: db },
    });

    const res = await request('/api/milestones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Beta launch',
        projectId,
        dueDate: '2025-06-01T00:00:00Z',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^ms_/);

    const [row] = await db
      .select()
      .from(schema.milestones)
      .where(eq(schema.milestones.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Beta launch');
    expect(row?.projectId).toBe(projectId);
  });

  it('POST / returns 400 with missing projectId', async () => {
    const { request } = createTestApp('/api/milestones', milestonesRoutes, {
      context: { permissions: permissions('milestones:create'), tenantDb: db },
    });
    const res = await request('/api/milestones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lonely', dueDate: '2025-01-01T00:00:00Z' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/projectId/);
  });

  it('POST / returns 400 with missing dueDate', async () => {
    const projectId = await seedProject();
    const { request } = createTestApp('/api/milestones', milestonesRoutes, {
      context: { permissions: permissions('milestones:create'), tenantDb: db },
    });
    const res = await request('/api/milestones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No date', projectId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/dueDate/);
  });
});
