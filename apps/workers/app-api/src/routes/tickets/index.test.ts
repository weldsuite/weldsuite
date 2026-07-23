/**
 * Route-level auth + validation tests for /api/tickets.
 *
 * The tickets route writes directly via Drizzle (no service layer yet),
 * so we can't easily mock the data path here. What we CAN cover with a
 * mock DB are the gates that fire before Drizzle is touched:
 *   - permission middleware
 *   - Zod validation on POST/PATCH
 *
 * Full happy-path tests come once tickets gets a service module or once
 * the harness layers pglite in.
 */

import { describe, it, expect } from 'vitest';
import { ticketsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

describe('/api/tickets · auth gates', () => {
  it('GET / returns 403 without tickets:read', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions() },
    });
    const res = await request('/api/tickets');
    expect(res.status).toBe(403);
  });

  it('POST / returns 403 without tickets:create', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions('tickets:read') },
    });
    const res = await request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('PATCH /:id returns 403 without tickets:update', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions('tickets:read') },
    });
    const res = await request('/api/tickets/tkt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /:id returns 403 without tickets:delete', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions('tickets:read') },
    });
    const res = await request('/api/tickets/tkt_1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});

describe('/api/tickets · validation', () => {
  it('POST / returns 400 with an empty body', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions('tickets:create') },
    });
    const res = await request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
