/**
 * DB-backed integration tests for /api/helpdesk-departments.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { helpdeskDepartmentsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/helpdesk-departments · pglite integration', () => {
  it('POST / writes a department row', async () => {
    const { request } = createTestApp('/api/helpdesk-departments', helpdeskDepartmentsRoutes, {
      context: { permissions: permissions('departments:create'), tenantDb: db },
    });

    const res = await request('/api/helpdesk-departments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Customer Support',
        email: 'support@e2e.test',
        color: '#3b82f6',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.helpdeskDepartments)
      .where(eq(schema.helpdeskDepartments.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Customer Support');
    expect(row?.email).toBe('support@e2e.test');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/helpdesk-departments', helpdeskDepartmentsRoutes, {
      context: { permissions: permissions('departments:create'), tenantDb: db },
    });
    const res = await request('/api/helpdesk-departments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});
