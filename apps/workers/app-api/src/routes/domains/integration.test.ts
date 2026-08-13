/**
 * DB-backed integration tests for /api/domains.
 *
 * GET / selects every column on `domains`. When the Drizzle schema drifts
 * ahead of tenant migrations (as with the Realtime Register columns), Neon
 * returns 500. This suite catches that class of failure against pglite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { domainsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/domains · pglite integration', () => {
  it('GET / returns 200 against an empty tenant', async () => {
    const { request } = createTestApp('/api/domains', domainsRoutes, {
      context: { permissions: permissions('domains:read'), tenantDb: db },
    });

    const res = await request('/api/domains?page=1&pageSize=10');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      domains: unknown[];
      pagination: { page: number; pageSize: number; total: number; totalPages: number };
      stats: { total: number; active: number; pending: number; expired: number };
    };
    expect(Array.isArray(body.domains)).toBe(true);
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 10 });
    expect(typeof body.stats.total).toBe('number');
  });

  it('GET / returns a created domain including Realtime Register columns', async () => {
    const created = await createTestApp('/api/domains', domainsRoutes, {
      context: { permissions: permissions('domains:create'), tenantDb: db },
    }).request('/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'example',
        tld: 'com',
        fullDomain: 'example.com',
        status: 'pending',
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: string } };

    const { request } = createTestApp('/api/domains', domainsRoutes, {
      context: { permissions: permissions('domains:read'), tenantDb: db },
    });
    const res = await request('/api/domains?page=1&pageSize=10');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      domains: Array<{
        id: string;
        fullDomain: string;
        rtrRegistrantHandle: string | null;
        rtrProcessId: string | null;
      }>;
    };
    const row = body.domains.find((d) => d.id === createdBody.data.id);
    expect(row?.fullDomain).toBe('example.com');
    expect(row).toHaveProperty('rtrRegistrantHandle');
    expect(row).toHaveProperty('rtrProcessId');

    const [dbRow] = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.id, createdBody.data.id))
      .limit(1);
    expect(dbRow?.fullDomain).toBe('example.com');
    expect(dbRow?.rtrRegistrantHandle).toBeNull();
    expect(dbRow?.rtrProcessId).toBeNull();
  });
});
