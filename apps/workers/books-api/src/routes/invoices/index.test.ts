/**
 * Auth + validation gates for /api/invoices. See `tickets/index.test.ts`
 * for the rationale (routes without a service layer can only test the
 * pre-DB gates; the database is an empty pglite one).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { invoicesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

// A real (empty) tenant database, so the conformance run can ask Rust too.
let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('/api/invoices · auth gates', () => {
  it('GET / returns 403 without invoices:read', async () => {
    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions(), tenantDb: db },
    });
    expect((await request('/api/invoices')).status).toBe(403);
  });

  it('POST / returns 403 without invoices:create', async () => {
    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:read'), tenantDb: db },
    });
    const res = await request('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('PATCH /:id returns 403 without invoices:update', async () => {
    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:read'), tenantDb: db },
    });
    const res = await request('/api/invoices/inv_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /:id returns 403 without invoices:delete', async () => {
    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:read'), tenantDb: db },
    });
    expect(
      (await request('/api/invoices/inv_1', { method: 'DELETE' })).status,
    ).toBe(403);
  });
});

// Note: invoices uses `.passthrough()` on a fully-optional schema, so
// there's no meaningful 400-on-empty-body case to cover here. The
// tickets test still exercises a schema with required fields.
