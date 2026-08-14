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
        registrar: string | null;
        rtrRegistrantHandle: string | null;
        rtrProcessId: string | null;
      }>;
    };
    const row = body.domains.find((d) => d.id === createdBody.data.id);
    expect(row?.fullDomain).toBe('example.com');
    expect(row?.registrar).toBe('WeldSuite');
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

  it('GET / hides unpaid checkout rows and remaps wholesale registrars to WeldSuite', async () => {
    const now = new Date();
    await db.insert(schema.hostDomains).values([
      {
        id: 'dom_paid_rtr',
        name: 'paid',
        tld: 'com',
        fullDomain: 'paid-rtr.com',
        status: 'active',
        registrationStatus: 'registered',
        registrar: 'realtimeregister',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'dom_unpaid_list',
        name: 'unpaid',
        tld: 'com',
        fullDomain: 'unpaid-list.com',
        status: 'pending',
        registrationStatus: 'pending_payment',
        registrar: 'realtimeregister',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'dom_godaddy',
        name: 'external',
        tld: 'com',
        fullDomain: 'external-godaddy.com',
        status: 'pending',
        registrar: 'GoDaddy',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'dom_cancelled_null',
        name: 'cancelled-null',
        tld: 'com',
        fullDomain: 'cancelled-null.com',
        status: 'cancelled',
        registrar: 'GoDaddy',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'dom_cancelled_failed',
        name: 'cancelled-failed',
        tld: 'com',
        fullDomain: 'cancelled-failed.com',
        status: 'cancelled',
        registrationStatus: 'failed',
        registrar: 'realtimeregister',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const { request } = createTestApp('/api/domains', domainsRoutes, {
      context: { permissions: permissions('domains:read'), tenantDb: db },
    });
    const res = await request('/api/domains?page=1&pageSize=50');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domains: Array<{ id: string; registrar: string | null }>;
    };
    const ids = body.domains.map((d) => d.id);
    expect(ids).toContain('dom_paid_rtr');
    expect(ids).toContain('dom_godaddy');
    expect(ids).toContain('dom_cancelled_null');
    expect(ids).not.toContain('dom_unpaid_list');
    expect(ids).not.toContain('dom_cancelled_failed');
    expect(body.domains.find((d) => d.id === 'dom_paid_rtr')?.registrar).toBe('WeldSuite');
    expect(body.domains.find((d) => d.id === 'dom_godaddy')?.registrar).toBe('GoDaddy');
  });

  it('GET /:id 404s unpaid checkout rows and remaps managed registrars', async () => {
    const now = new Date();
    await db.insert(schema.hostDomains).values([
      {
        id: 'dom_unpaid_get',
        name: 'unpaid-get',
        tld: 'com',
        fullDomain: 'unpaid-get.com',
        status: 'pending',
        registrationStatus: 'pending_payment',
        registrar: 'realtimeregister',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'dom_paid_get',
        name: 'paid-get',
        tld: 'com',
        fullDomain: 'paid-get.com',
        status: 'active',
        registrationStatus: 'registered',
        registrar: 'cloudflare',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const { request } = createTestApp('/api/domains', domainsRoutes, {
      context: { permissions: permissions('domains:read'), tenantDb: db },
    });

    const hidden = await request('/api/domains/dom_unpaid_get');
    expect(hidden.status).toBe(404);

    const paid = await request('/api/domains/dom_paid_get');
    expect(paid.status).toBe(200);
    const paidBody = (await paid.json()) as { data: { registrar: string } };
    expect(paidBody.data.registrar).toBe('WeldSuite');
  });

  it('POST /checkout/abandon soft-deletes unpaid rows', async () => {
    const now = new Date();
    await db.insert(schema.hostDomains).values({
      id: 'dom_abandon_api',
      name: 'abandon-api',
      tld: 'com',
      fullDomain: 'abandon-api.com',
      status: 'pending',
      registrationStatus: 'pending_payment',
      registrar: 'realtimeregister',
      createdAt: now,
      updatedAt: now,
    });

    const { request } = createTestApp('/api/domains', domainsRoutes, {
      context: { permissions: permissions('domains:create'), tenantDb: db },
    });
    const res = await request('/api/domains/checkout/abandon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationIds: ['dom_abandon_api'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { abandoned: number } };
    expect(body.data.abandoned).toBe(1);

    const [row] = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.id, 'dom_abandon_api'))
      .limit(1);
    expect(row?.deletedAt).not.toBeNull();
  });
});
