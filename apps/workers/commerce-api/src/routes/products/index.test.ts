/**
 * Auth + validation gates for /api/products. See `tickets/index.test.ts`
 * for the rationale.
 */

import { describe, it, expect } from 'vitest';
import { productsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';

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

describe('/api/products · tax fields validation', () => {
  const json = { 'Content-Type': 'application/json' };

  it.each(['bogus', 'taxable', 'txcd_123', 'p0000000', 'GENERAL'])(
    'POST / returns 400 for taxClass %s',
    async (taxClass) => {
      const { request } = createTestApp('/api/products', productsRoutes, {
        context: { permissions: permissions('products:create') },
      });
      const res = await request('/api/products', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'Widget', slug: 'widget-1', taxClass }),
      });
      expect(res.status).toBe(400);
    },
  );

  it('POST / returns 400 for a taxClass longer than 50 characters', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create') },
    });
    const res = await request('/api/products', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'Widget', slug: 'widget-1', taxClass: 'x'.repeat(51) }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / returns 400 for a non-boolean taxable', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:create') },
    });
    const res = await request('/api/products', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'Widget', slug: 'widget-1', taxable: 'no' }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /:id returns 400 for an unknown taxClass', async () => {
    const { request } = createTestApp('/api/products', productsRoutes, {
      context: { permissions: permissions('products:update') },
    });
    const res = await request('/api/products/prod_1', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ taxClass: 'reduced' }),
    });
    expect(res.status).toBe(400);
  });
});
