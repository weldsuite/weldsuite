/**
 * Auth + validation gates for /api/invoices. See `tickets/index.test.ts`
 * for the rationale (routes without a service layer can only test the
 * pre-DB gates without pglite).
 */

import { describe, it, expect } from 'vitest';
import { invoicesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

describe('/api/invoices · auth gates', () => {
  it('GET / returns 403 without invoices:read', async () => {
    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions() },
    });
    expect((await request('/api/invoices')).status).toBe(403);
  });

  it('POST / returns 403 without invoices:create', async () => {
    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:read') },
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
      context: { permissions: permissions('invoices:read') },
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
      context: { permissions: permissions('invoices:read') },
    });
    expect(
      (await request('/api/invoices/inv_1', { method: 'DELETE' })).status,
    ).toBe(403);
  });
});

// Note: invoices uses `.passthrough()` on a fully-optional schema, so
// there's no meaningful 400-on-empty-body case to cover here. The
// tickets test still exercises a schema with required fields.
