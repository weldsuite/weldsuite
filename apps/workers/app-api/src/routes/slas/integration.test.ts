/**
 * DB-backed integration tests for /api/slas.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { slasRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/slas · pglite integration', () => {
  it('POST / writes an SLA row', async () => {
    const { request } = createTestApp('/api/slas', slasRoutes, {
      context: { permissions: permissions('slas:create'), tenantDb: db },
    });

    const res = await request('/api/slas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Standard SLA',
        responseTimeMinutes: 60,
        resolutionTimeMinutes: 480,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.helpdeskSlas)
      .where(eq(schema.helpdeskSlas.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Standard SLA');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/slas', slasRoutes, {
      context: { permissions: permissions('slas:create'), tenantDb: db },
    });
    const res = await request('/api/slas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});
