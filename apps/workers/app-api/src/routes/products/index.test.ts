/**
 * Auth + validation gates for /api/products. See `tickets/index.test.ts`
 * for the rationale.
 */

import { describe, it, expect } from 'vitest';
import { productsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

describe('/api/products · auth gates', () => {
  it('GET / returns 403 without products:read', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions() },
    });
    expect((await request('/api/products')).status).toBe(403);
  });

  it('POST / returns 403 without products:create', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:read') },
    });
    const res = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('PATCH /:id returns 403 without products:update', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:read') },
    });
    const res = await request('/api/products/prod_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /:id returns 403 without products:delete', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:read') },
    });
    expect(
      (await request('/api/products/prod_1', { method: 'DELETE' })).status,
    ).toBe(403);
  });

  it('POST /:id/sales-channels returns 403 without products:update', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:read') },
    });
    const res = await request('/api/products/prod_1/sales-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: 'conn_1' }),
    });
    expect(res.status).toBe(403);
  });

  it('PATCH /:id/sales-channels/:channelId returns 403 without products:update', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:read') },
    });
    const res = await request('/api/products/prod_1/sales-channels/psch_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: '9.00' }),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /:id/sales-channels/:channelId returns 403 without products:update', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:read') },
    });
    expect(
      (await request('/api/products/prod_1/sales-channels/psch_1', { method: 'DELETE' })).status,
    ).toBe(403);
  });
});

describe('/api/products · validation', () => {
  it('POST / returns 400 with an empty body', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create') },
    });
    const res = await request('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
