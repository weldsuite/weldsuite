/**
 * /api/grid-views: a member's column visibility and widths per grid, and the
 * workspace-wide row for the shared grids (`customer`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { gridViewsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function app(userId = 'user_grid', ...keys: string[]) {
  return createTestApp('/api/grid-views', gridViewsRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...(keys.length ? keys : ['general:read'])) },
  });
}

function put(userId: string, grid: string, body: unknown) {
  return app(userId).request(`/api/grid-views/${grid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/grid-views', () => {
  it('answers null for a grid the member never configured', async () => {
    const res = await app().request('/api/grid-views/tickets');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });

  it('stores a member’s view, then updates it in place', async () => {
    const first = await put('user_grid', 'companies', { columnVisibility: { name: true, city: false }, columnWidths: { name: 240 } });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: { columnVisibility: { name: true, city: false }, columnWidths: { name: 240 } } });

    const read = await app('user_grid').request('/api/grid-views/companies');
    expect(await read.json()).toEqual({ data: { columnVisibility: { name: true, city: false }, columnWidths: { name: 240 } } });

    const second = await put('user_grid', 'companies', { columnVisibility: { city: true }, columnWidths: { name: 180.5, city: 90 } });
    expect(second.status).toBe(200);
    const rows = await db
      .select()
      .from(schema.gridViews)
      .where(and(eq(schema.gridViews.userId, 'user_grid'), eq(schema.gridViews.gridName, 'companies')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.columnWidths).toEqual({ name: 180.5, city: 90 });

    // Another member has their own row.
    const other = await app('user_other').request('/api/grid-views/companies');
    expect(await other.json()).toEqual({ data: null });
  });

  it('shares the customer grid across the workspace', async () => {
    const saved = await put('user_a', 'customer', { columnVisibility: { email: false }, columnWidths: {} });
    expect(saved.status).toBe(200);
    const res = await app('user_b').request('/api/grid-views/customer');
    expect(await res.json()).toEqual({ data: { columnVisibility: { email: false }, columnWidths: {} } });
  });

  it('refuses a body that is not two maps', async () => {
    const res = await put('user_grid', 'companies', { columnVisibility: { name: 'yes' }, columnWidths: { name: '240' } });
    expect(res.status).toBe(400);
    const missing = await put('user_grid', 'companies', { columnVisibility: {} });
    expect(missing.status).toBe(400);
    const notObject = await put('user_grid', 'companies', { columnVisibility: [], columnWidths: null });
    expect(notObject.status).toBe(400);
  });

  it('needs general:read', async () => {
    const res = await app('user_grid', 'companies:read').request('/api/grid-views/companies');
    expect(res.status).toBe(403);
    const write = await createTestApp('/api/grid-views', gridViewsRoutes, {
      context: { tenantDb: db, permissions: permissions('companies:read') },
    }).request('/api/grid-views/companies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnVisibility: {}, columnWidths: {} }),
    });
    expect(write.status).toBe(403);
  });
});
