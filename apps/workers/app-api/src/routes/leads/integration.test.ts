/**
 * DB-backed integration tests for /api/leads.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { leadsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/leads · pglite integration', () => {
  it('POST / writes a lead and publishes lead.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/leads', leadsRoutes, {
      context: { permissions: permissions('leads:create'), tenantDb: db },
    });

    const res = await request('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Lead',
        email: 'new.lead@e2e.test',
        companyName: 'Acme',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^lead_/);

    const [row] = await db
      .select()
      .from(schema.crmLeads)
      .where(eq(schema.crmLeads.id, body.data.id))
      .limit(1);
    expect(row?.email).toBe('new.lead@e2e.test');
    expect(row?.firstName).toBe('New');

    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const call = mockedPublish.mock.calls[0]![0] as {
      entityType: string;
      action: string;
    };
    expect(call.entityType).toBe('lead');
    expect(call.action).toBe('created');
  });

  it('POST / rejects an invalid email', async () => {
    const { request } = createTestApp('/api/leads', leadsRoutes, {
      context: { permissions: permissions('leads:create'), tenantDb: db },
    });
    const res = await request('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns 404 for a missing lead', async () => {
    const { request } = createTestApp('/api/leads', leadsRoutes, {
      context: { permissions: permissions('leads:read'), tenantDb: db },
    });
    const res = await request('/api/leads/lead_missing');
    expect(res.status).toBe(404);
  });
});
