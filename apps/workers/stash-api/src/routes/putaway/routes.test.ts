/**
 * Every /api/putaway route on pglite: putaway tasks (`inventory_movements`
 * rows of type `putaway`): list with status counts, detail, create, start,
 * complete (stock lands at the location, with its audit row), assign and
 * cancel. Runs against Rust in conformance mode (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json } from '../../test/crud-suite';
import { makeLocation, makeProduct, makeWarehouse } from '../../test/fixtures';
import { putawayRoutes } from './index';

let db: Database;
let warehouseId: string;
let productId: string;
let locationId: string;
let otherLocationId: string;
const base = '/api/putaway';
const app = (...keys: string[]) =>
  createTestApp(base, putawayRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const task = (n: number, overrides: Partial<typeof schema.inventoryMovements.$inferInsert> = {}) => ({
  id: `put_seed${n}`,
  movementNumber: `PUT-SEED${n}`,
  movementType: 'putaway',
  productId,
  quantity: n,
  destWarehouseId: warehouseId,
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, n)),
  ...overrides,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  warehouseId = await makeWarehouse(db);
  productId = await makeProduct(db);
  locationId = await makeLocation(db, warehouseId);
  otherLocationId = await makeLocation(db, warehouseId);
  await db.insert(schema.inventoryMovements).values([
    task(1, { destLocationId: locationId, notes: 'needle pallet' }),
    task(2, { status: 'in_progress', priority: 'high', assignedTo: 'user_a' }),
    task(3, { status: 'completed' }),
    task(4, { status: 'cancelled' }),
    task(5, { destWarehouseId: 'wh_other' }),
    task(6, { destWarehouseId: null }),
    task(7, { createdAt: new Date(Date.UTC(2026, 0, 2)) }),
    task(8, { createdAt: new Date(Date.UTC(2026, 0, 2)) }),
    task(9, { movementType: 'transfer', id: 'mov_seed9' }),
  ]);
}, 60_000);

describe('/api/putaway · list and detail', () => {
  it('lists with the status counts, hiding cancelled tasks by default', async () => {
    const res = await app('inventory:read').request(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; counts: { cancelled: number } };
    expect(body.counts.cancelled).toBe(1);
    expect(body.data.some((row) => row.id === 'put_seed4')).toBe(false);
  });

  it('filters and pages', async () => {
    const { request } = app('inventory:read');
    for (const query of [
      'search=needle',
      'search=PUT-SEED2',
      'status=cancelled',
      'status=all',
      `warehouseId=${warehouseId}`,
      'warehouseId=all',
      'assignedTo=user_a',
      'priority=high',
      'priority=all',
      'limit=2',
      'limit=0',
      'limit=nope',
      'cursor=put_seed3&limit=2',
      'cursor=put_missing&priority=high',
    ]) {
      expect((await request(`${base}?${query}`)).status, query).toBe(200);
    }
    expect((await app().request(base)).status).toBe(403);
  });

  it('answers a task, 404 for a missing one or another movement type', async () => {
    const { request } = app('inventory:read');
    expect((await request(`${base}/put_seed1`)).status).toBe(200);
    expect((await request(`${base}/put_missing`)).status).toBe(404);
    expect((await request(`${base}/mov_seed9`)).status).toBe(404);
    expect((await app().request(`${base}/put_seed1`)).status).toBe(403);
  });
});

describe('/api/putaway · create', () => {
  it('creates a pending task', async () => {
    const { request } = app('inventory:create');
    const res = await request(
      base,
      json({ warehouseId, productId, quantity: 4, targetLocationId: locationId, priority: 'urgent', notes: 'dock 2' }),
    );
    expect(res.status).toBe(201);
    expect((await request(base, json({ warehouseId, productId, quantity: 1 }))).status).toBe(201);
  });

  it('refuses an invalid task', async () => {
    const { request } = app('inventory:create');
    for (const body of [
      {},
      { warehouseId, productId, quantity: 0 },
      { warehouseId, productId, quantity: 1.5 },
      { warehouseId, productId, quantity: 1, priority: 'asap' },
      { warehouseId: '', productId: '', quantity: 1 },
    ]) {
      expect((await request(base, json(body))).status).toBe(400);
    }
    expect((await request(base, json({ warehouseId, productId, quantity: 1, sourceId: 'x'.repeat(31) }))).status).toBe(500);
    expect((await app('inventory:read').request(base, json({ warehouseId, productId, quantity: 1 }))).status).toBe(403);
  });
});

describe('/api/putaway · start, assign, complete, cancel', () => {
  it('starts a task', async () => {
    const { request } = app('inventory:update');
    expect((await request(`${base}/put_seed5/start`, { method: 'PATCH' })).status).toBe(200);
    expect((await request(`${base}/put_seed4/start`, { method: 'PATCH' })).status).toBe(404);
    expect((await request(`${base}/put_missing/start`, { method: 'PATCH' })).status).toBe(404);
    expect((await app().request(`${base}/put_seed5/start`, { method: 'PATCH' })).status).toBe(403);
  });

  it('assigns a task', async () => {
    const { request } = app('inventory:update');
    expect((await request(`${base}/put_seed5/assign`, json({ assignedTo: 'user_b', assignedToName: 'B' }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/put_seed5/assign`, json({ assignedTo: null }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/put_seed5/assign`, json({}, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/put_seed5/assign`, json({ assignedTo: 5 }, 'PATCH'))).status).toBe(400);
    expect((await request(`${base}/put_seed4/assign`, json({ assignedTo: 'user_b' }, 'PATCH'))).status).toBe(404);
    expect((await app().request(`${base}/put_seed5/assign`, json({}, 'PATCH'))).status).toBe(403);
  });

  it('completes a task into a new bucket, then into the existing one', async () => {
    const { request } = app('inventory:update');
    const first = await request(`${base}/put_seed7/complete`, json({ locationId: otherLocationId }, 'PATCH'));
    expect(first.status).toBe(200);
    const second = await request(`${base}/put_seed8/complete`, json({ locationId: otherLocationId, quantity: 2 }, 'PATCH'));
    expect(second.status).toBe(200);
    const [bucket] = await db
      .select()
      .from(schema.inventory)
      .where(and(eq(schema.inventory.locationId, otherLocationId), eq(schema.inventory.productId, productId)))
      .limit(1);
    expect(bucket?.quantityOnHand).toBe(9);
    expect((await request(`${base}/put_seed1/complete`, json({ locationId, quantity: 0 }, 'PATCH'))).status).toBe(200);
  });

  it('refuses to complete a task without a destination, a cancelled or missing one, or a bad body', async () => {
    const { request } = app('inventory:update');
    expect((await request(`${base}/put_seed6/complete`, json({ locationId }, 'PATCH'))).status).toBe(400);
    expect((await request(`${base}/put_seed4/complete`, json({ locationId }, 'PATCH'))).status).toBe(404);
    expect((await request(`${base}/put_missing/complete`, json({ locationId }, 'PATCH'))).status).toBe(404);
    expect((await request(`${base}/put_seed2/complete`, json({ locationId: '' }, 'PATCH'))).status).toBe(400);
    expect((await request(`${base}/put_seed2/complete`, json({ locationId, quantity: -1 }, 'PATCH'))).status).toBe(400);
    expect((await app().request(`${base}/put_seed2/complete`, json({ locationId }, 'PATCH'))).status).toBe(403);
  });

  it('cancels a task', async () => {
    const { request } = app('inventory:delete');
    expect((await request(`${base}/put_seed2`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${base}/put_seed2`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${base}/mov_seed9`, { method: 'DELETE' })).status).toBe(404);
    expect((await app().request(`${base}/put_seed3`, { method: 'DELETE' })).status).toBe(403);
  });
});
