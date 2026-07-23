/**
 * DB-backed integration tests for /api/projects.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/projects · pglite integration', () => {
  it('POST / writes a project row', async () => {
    const { request } = createTestApp('/api/projects', projectsRoutes, {
      context: { permissions: permissions('projects:create'), tenantDb: db },
    });

    const res = await request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Q1 Sprint',
        description: 'Test project',
        color: '#3b82f6',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^prj_/);

    const [row] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Q1 Sprint');
    expect(row?.description).toBe('Test project');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/projects', projectsRoutes, {
      context: { permissions: permissions('projects:create'), tenantDb: db },
    });
    const res = await request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns 404 for missing project', async () => {
    // An elevated (scope:all) caller passes the access gate, so a missing id
    // resolves to a genuine 404 rather than the membership 403.
    const { request } = createTestApp('/api/projects', projectsRoutes, {
      context: { permissions: permissions('projects:read', 'projects:scope:all'), tenantDb: db },
    });
    const res = await request('/api/projects/prj_missing');
    expect(res.status).toBe(404);
  });
});
