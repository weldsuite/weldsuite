/**
 * DB-backed integration tests for /api/boxes (shipping boxes).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { boxesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/boxes · pglite integration', () => {
  it('POST / writes a box row with required dimensions', async () => {
    const { request } = createTestApp('/api/boxes', boxesRoutes, {
      context: { permissions: permissions('boxes:create'), tenantDb: db },
    });

    const res = await request('/api/boxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Medium Mailer',
        code: 'BX-M',
        length: 30,
        width: 20,
        height: 10,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.boxes)
      .where(eq(schema.boxes.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Medium Mailer');
    expect(row?.code).toBe('BX-M');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/boxes', boxesRoutes, {
      context: { permissions: permissions('boxes:create'), tenantDb: db },
    });
    const res = await request('/api/boxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', code: 'X', length: 1, width: 1, height: 1 }),
    });
    expect(res.status).toBe(400);
  });
});
