/**
 * Every /api/inventory route on pglite: stock buckets (list with names, the
 * stock ledger, detail, create, patch, delete) and the ledger writes behind
 * them (adjust, transfer), with their refusals. Runs against Rust in
 * conformance mode (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json } from '../../test/crud-suite';
import { makeLocation, makeProduct, makeWarehouse, receive } from '../../test/fixtures';
import { applyStockChange } from '../../services/inventory-ledger';
import { inventoryRoutes } from './index';

let db: Database;
let warehouseId: string;
let otherWarehouseId: string;
let productId: string;
let lotProductId: string;
let expiryProductId: string;
let backorderProductId: string;
let locationId: string;
let bucketId: string;
const base = '/api/inventory';
const app = (...keys: string[]) =>
  createTestApp(base, inventoryRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  warehouseId = await makeWarehouse(db, { name: 'Main' });
  otherWarehouseId = await makeWarehouse(db, { name: 'Overflow' });
  productId = await makeProduct(db, { name: 'Bolt', lowStockThreshold: 20 });
  lotProductId = await makeProduct(db, { name: 'Milk', trackLots: true });
  expiryProductId = await makeProduct(db, { name: 'Cheese', trackExpiry: true });
  backorderProductId = await makeProduct(db, { name: 'Preorder', allowBackorder: true });
  locationId = await makeLocation(db, warehouseId);
  bucketId = await receive(db, { productId, warehouseId, quantity: 12, locationId });
  await receive(db, { productId, warehouseId: otherWarehouseId, quantity: 40 });
  await receive(db, { productId: lotProductId, warehouseId, quantity: 5, lotNumber: 'L-1' });
  await db.insert(schema.inventory).values([
    { id: 'inv_orphan', productId: 'prod_gone', warehouseId: 'wh_gone', quantityOnHand: 1, createdAt: new Date(Date.UTC(2025, 0, 1)) },
    { id: 'inv_deleted', productId, warehouseId, lotNumber: 'OLD', deletedAt: new Date() },
  ]);
  await db.insert(schema.stockAdjustments).values([
    { id: 'adj_tie1', productId, type: 'increase', previousQuantity: 0, adjustmentQuantity: 1, newQuantity: 1, createdAt: new Date(Date.UTC(2025, 5, 1)) },
    { id: 'adj_tie2', productId, type: 'increase', previousQuantity: 1, adjustmentQuantity: 1, newQuantity: 2, createdAt: new Date(Date.UTC(2025, 5, 1)) },
  ]);
}, 60_000);

describe('/api/inventory · list', () => {
  it('lists buckets with product, warehouse and location names', async () => {
    const res = await app('inventory:read').request(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ productName: string | null }> };
    expect(body.data.some((row) => row.productName === 'Bolt')).toBe(true);
  });

  it('filters and pages', async () => {
    const { request } = app('inventory:read');
    const first = (await (await request(`${base}?limit=2`)).json()) as { pagination: { cursor: string } };
    for (const query of [
      `productId=${productId}`,
      `warehouseId=${warehouseId}`,
      'lowStockOnly=true',
      'lowStockOnly=false',
      'productId=&warehouseId=',
      `limit=2&cursor=${first.pagination.cursor}`,
      'cursor=inv_missing&lowStockOnly=true',
      'limit=0',
      'limit=abc',
    ]) {
      expect((await request(`${base}?${query}`)).status, query).toBe(200);
    }
    expect((await app().request(base)).status).toBe(403);
  });
});

describe('/api/inventory/ledger', () => {
  it('reads the stock ledger with names', async () => {
    const res = await app('inventory:read').request(`${base}/ledger`);
    expect(res.status).toBe(200);
  });

  it('filters by bucket, type and date range, and pages', async () => {
    const { request } = app('inventory:read');
    const first = (await (await request(`${base}/ledger?limit=2`)).json()) as { pagination: { cursor: string } };
    for (const query of [
      `productId=${productId}`,
      'variantId=var_none',
      `warehouseId=${warehouseId}`,
      `locationId=${locationId}`,
      'lotNumber=L-1',
      'type=received',
      'sourceType=manual',
      'from=2025-01-01',
      'to=2025-06-01T00:00:00.000Z',
      'from=2025-05-01&to=2030-01-01',
      `limit=2&cursor=${first.pagination.cursor}`,
      'cursor=adj_tie2&limit=5',
      'cursor=adj_missing&type=increase',
      'limit=100',
    ]) {
      expect((await request(`${base}/ledger?${query}`)).status, query).toBe(200);
    }
  });

  it('refuses a query it cannot read', async () => {
    const { request } = app('inventory:read');
    for (const query of ['type=lost', 'limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'from=yesterday', 'productId=' + 'x'.repeat(31)]) {
      expect((await request(`${base}/ledger?${query}`)).status, query).toBe(400);
    }
    expect((await app().request(`${base}/ledger`)).status).toBe(403);
  });
});

describe('/api/inventory/:id', () => {
  it('answers a bucket, 404 when missing or deleted', async () => {
    const { request } = app('inventory:read');
    expect((await request(`${base}/${bucketId}`)).status).toBe(200);
    expect((await request(`${base}/inv_missing`)).status).toBe(404);
    expect((await request(`${base}/inv_deleted`)).status).toBe(404);
    expect((await app().request(`${base}/${bucketId}`)).status).toBe(403);
  });
});

describe('/api/inventory · create a bucket', () => {
  it('creates an empty bucket', async () => {
    const { request } = app('inventory:create');
    const location = await makeLocation(db, warehouseId);
    const res = await request(
      base,
      json({
        productId,
        warehouseId,
        locationId: location,
        lotNumber: 'NEW-LOT',
        expiryDate: '2027-01-01',
        manufactureDate: null,
        unitCost: 2.5,
        currency: 'EUR',
        status: 'quarantine',
        qualityStatus: 'pending',
        metadata: { bay: 1 },
      }),
    );
    expect(res.status).toBe(201);
    expect((await request(base, json({ productId: backorderProductId, warehouseId }))).status).toBe(201);
  });

  it('answers its 500 for a bucket that already exists', async () => {
    const res = await app('inventory:create').request(base, json({ productId, warehouseId, locationId }));
    expect(res.status).toBe(500);
  });

  it('refuses an invalid bucket', async () => {
    const { request } = app('inventory:create');
    for (const body of [
      {},
      { productId, warehouseId, currency: 'EURO' },
      { productId, warehouseId, unitCost: -1 },
      { productId, warehouseId, expiryDate: 'soon' },
      { productId, warehouseId, metadata: 'x' },
    ]) {
      expect((await request(base, json(body))).status).toBe(400);
    }
    expect((await app('inventory:read').request(base, json({ productId, warehouseId }))).status).toBe(403);
  });
});

describe('/api/inventory/adjust', () => {
  it('receives stock into a new bucket and into an existing one', async () => {
    const { request } = app('inventory:update');
    const location = await makeLocation(db, warehouseId);
    const first = await request(
      `${base}/adjust`,
      json({ productId, warehouseId, locationId: location, delta: 5, reason: 'Receipt', unitCost: 3, sourceType: 'purchase_order', sourceId: 'po_1', sourceNumber: 'PO-1' }),
    );
    expect(first.status).toBe(200);
    const second = await request(
      `${base}/adjust`,
      json({ productId, warehouseId, locationId: location, delta: 3, reason: 'Receipt', unitCost: 5, reasonCode: 'RECEIVED', notes: 'n' }),
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { quantityOnHand: number } }).data.quantityOnHand).toBe(8);
    const issue = await request(`${base}/adjust`, json({ productId, warehouseId, locationId: location, delta: -2, reason: 'Damage', type: 'damage' }));
    expect(issue.status).toBe(200);
  });

  it('refuses an oversell with 409, and lets a backorder product go negative', async () => {
    const { request } = app('inventory:update');
    expect((await request(`${base}/adjust`, json({ productId, warehouseId, locationId, delta: -999, reason: 'x' }))).status).toBe(409);
    expect((await request(`${base}/adjust`, json({ productId, warehouseId: 'wh_empty', delta: -1, reason: 'x' }))).status).toBe(409);
    expect((await request(`${base}/adjust`, json({ productId: backorderProductId, warehouseId, delta: -2, reason: 'Presold' }))).status).toBe(200);
    expect((await request(`${base}/adjust`, json({ productId: backorderProductId, warehouseId, delta: -1, reason: 'Presold' }))).status).toBe(200);
  });

  it('maps the ledger refusals', async () => {
    const { request } = app('inventory:update');
    expect((await request(`${base}/adjust`, json({ productId: 'prod_missing', warehouseId, delta: 1, reason: 'x' }))).status).toBe(404);
    expect((await request(`${base}/adjust`, json({ productId, warehouseId, delta: 0, reason: 'x' }))).status).toBe(400);
    expect((await request(`${base}/adjust`, json({ productId: lotProductId, warehouseId, delta: 1, reason: 'x' }))).status).toBe(400);
    expect((await request(`${base}/adjust`, json({ productId: lotProductId, warehouseId, delta: 2, reason: 'x', lotNumber: 'L-2', batchNumber: 'B' }))).status).toBe(200);
    expect((await request(`${base}/adjust`, json({ productId: lotProductId, warehouseId, delta: -1, reason: 'x', lotNumber: 'L-1' }))).status).toBe(200);
    expect((await request(`${base}/adjust`, json({ productId: expiryProductId, warehouseId, delta: 1, reason: 'x' }))).status).toBe(400);
    expect((await request(`${base}/adjust`, json({ productId: expiryProductId, warehouseId, delta: 1, reason: 'x', expiryDate: '2027-06-01' }))).status).toBe(200);
  });

  it('refuses an invalid body', async () => {
    const { request } = app('inventory:update');
    for (const body of [
      {},
      { productId, warehouseId, delta: 1 },
      { productId, warehouseId, delta: 1.5, reason: 'x' },
      { productId, warehouseId, delta: 1, reason: 'x', type: 'stolen' },
      { productId, warehouseId, delta: 1, reason: '', unitCost: -2 },
      { productId, warehouseId, delta: 1, reason: 'x', expiryDate: 'never' },
    ]) {
      expect((await request(`${base}/adjust`, json(body))).status).toBe(400);
    }
    expect((await app('inventory:read').request(`${base}/adjust`, json({ productId, warehouseId, delta: 1, reason: 'x' }))).status).toBe(403);
  });
});

describe('/api/inventory/transfer', () => {
  it('moves stock between warehouses', async () => {
    const res = await app('inventory:update').request(
      `${base}/transfer`,
      json({
        productId,
        quantity: 4,
        from: { warehouseId: otherWarehouseId },
        to: { warehouseId, locationId },
        reason: 'Rebalance',
        notes: 'truck 1',
      }),
    );
    expect(res.status).toBe(201);
  });

  it('refuses a transfer to the same bucket, an oversell, a failed credit and a bad body', async () => {
    const { request } = app('inventory:update');
    expect((await request(`${base}/transfer`, json({ productId, quantity: 1, from: { warehouseId }, to: { warehouseId } }))).status).toBe(400);
    expect(
      (await request(`${base}/transfer`, json({ productId, quantity: 1, from: { warehouseId: 'wh_nowhere', lotNumber: 'L-1' }, to: { warehouseId } }))).status,
    ).toBe(409);
    expect((await request(`${base}/transfer`, json({ productId, quantity: 9999, from: { warehouseId: otherWarehouseId }, to: { warehouseId } }))).status).toBe(409);
    // An omitted destination lot keeps the source's.
    expect(
      (await request(`${base}/transfer`, json({ productId: lotProductId, quantity: 1, from: { warehouseId, lotNumber: 'L-1' }, to: { warehouseId: otherWarehouseId, lotNumber: null } }))).status,
    ).toBe(201);
    // The credit leg of an expiry-tracked product needs an expiry the transfer
    // never has: the debit is compensated (which fails the same way), then refused.
    await applyStockChange(db, {
      productId: expiryProductId,
      warehouseId: otherWarehouseId,
      delta: 3,
      type: 'received',
      expiryDate: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(
      (await request(`${base}/transfer`, json({ productId: expiryProductId, quantity: 1, from: { warehouseId: otherWarehouseId }, to: { warehouseId } }))).status,
    ).toBe(400);
    expect((await request(`${base}/transfer`, json({ productId: 'prod_missing', quantity: 1, from: { warehouseId }, to: { warehouseId: otherWarehouseId } }))).status).toBe(404);
    for (const body of [
      {},
      { productId, quantity: 0, from: { warehouseId }, to: { warehouseId: otherWarehouseId } },
      { productId, quantity: 1, from: { warehouseId: '' }, to: {} },
      { productId, quantity: 1, from: 'here', to: { warehouseId } },
    ]) {
      expect((await request(`${base}/transfer`, json(body))).status).toBe(400);
    }
    expect((await app('inventory:read').request(`${base}/transfer`, json({ productId, quantity: 1, from: { warehouseId }, to: { warehouseId: otherWarehouseId } }))).status).toBe(403);
  });
});

describe('/api/inventory · patch and delete', () => {
  it('patches a bucket\'s attributes', async () => {
    const { request } = app('inventory:update');
    expect((await request(`${base}/${bucketId}`, json({ unitCost: 4.25, isQuarantined: true, quarantineReason: 'leak' }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/${bucketId}`, json({ lastInspectionDate: '2026-03-01', expiryDate: null, locationId: null }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/${bucketId}`, json({ status: 'available', metadata: { ok: true }, unitCost: null }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/${bucketId}`, json({ productId: 'ignored' }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/inv_missing`, json({ status: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await request(`${base}/${bucketId}`, json({ currency: 'EURO' }, 'PATCH'))).status).toBe(400);
    expect((await request(`${base}/${bucketId}`, json({ isQuarantined: 'yes' }, 'PATCH'))).status).toBe(400);
    expect((await app().request(`${base}/${bucketId}`, json({ status: 'x' }, 'PATCH'))).status).toBe(403);
  });

  it('answers its 500 when a patch cannot be stored', async () => {
    const res = await app('inventory:update').request(`${base}/${bucketId}`, json({ unitCost: 1e20 }, 'PATCH'));
    expect(res.status).toBe(500);
  });

  it('soft-deletes a bucket', async () => {
    const { request } = app('inventory:delete');
    expect((await request(`${base}/inv_orphan`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${base}/inv_orphan`, { method: 'DELETE' })).status).toBe(404);
    expect((await app().request(`${base}/${bucketId}`, { method: 'DELETE' })).status).toBe(403);
  });
});
