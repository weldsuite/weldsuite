/**
 * Every /api/stock-adjustments route on pglite: the append-only audit trail
 * (list with filters and paging, detail, create). Runs against Rust in
 * conformance mode (rust/conformance/suites.json).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { json } from '../../test/crud-suite';
import { stockAdjustmentsRoutes } from './index';

let db: Database;
const base = '/api/stock-adjustments';
const app = (...keys: string[]) =>
  createTestApp(base, stockAdjustmentsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const row = (n: number, overrides: Partial<typeof schema.stockAdjustments.$inferInsert> = {}) => ({
  id: `adj_seed${n}`,
  productId: 'prod_seed',
  type: 'increase',
  previousQuantity: n,
  adjustmentQuantity: 1,
  newQuantity: n + 1,
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, n)),
  ...overrides,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.stockAdjustments).values([
    row(1),
    row(2, { reason: 'Found a needle in stock', warehouseId: 'wh_a' }),
    row(3, { notes: 'haystack recount', type: 'correction', sourceType: 'cycle_count' }),
    row(4, { productId: 'prod_other', warehouseId: 'wh_b', type: 'damage' }),
    row(5, { createdAt: new Date(Date.UTC(2026, 0, 2)) }),
    row(6, { createdAt: new Date(Date.UTC(2026, 0, 2)) }),
  ]);
}, 60_000);

describe('/api/stock-adjustments · list', () => {
  it('lists newest first with the count', async () => {
    const res = await app('inventory:read').request(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: { totalCount: number } };
    expect(body.data.length).toBe(body.pagination.totalCount);
  });

  it('filters', async () => {
    const { request } = app('inventory:read');
    for (const query of [
      'search=needle',
      'search=haystack',
      'type=correction',
      'warehouseId=wh_a',
      'productId=prod_other',
      'sourceType=cycle_count',
      'search=&type=&warehouseId=',
      'type=damage&productId=prod_seed',
    ]) {
      expect((await request(`${base}?${query}`)).status).toBe(200);
    }
  });

  it('pages with a cursor; a cursor that is gone is ignored', async () => {
    const { request } = app('inventory:read');
    const first = (await (await request(`${base}?limit=2`)).json()) as { pagination: { cursor: string } };
    expect((await request(`${base}?limit=2&cursor=${first.pagination.cursor}`)).status).toBe(200);
    expect((await request(`${base}?cursor=adj_missing&type=increase`)).status).toBe(200);
    for (const limit of ['0', 'abc', '-1', '500']) {
      expect((await request(`${base}?limit=${limit}`)).status).toBe(200);
    }
  });

  it('needs inventory:read', async () => {
    expect((await app().request(base)).status).toBe(403);
  });
});

describe('/api/stock-adjustments · detail', () => {
  it('answers the row, 404 when missing, 403 without inventory:read', async () => {
    const { request } = app('inventory:read');
    const res = await request(`${base}/adj_seed2`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { reason: string } }).data.reason).toBe('Found a needle in stock');
    expect((await request(`${base}/adj_missing`)).status).toBe(404);
    expect((await app().request(`${base}/adj_seed2`)).status).toBe(403);
  });
});

describe('/api/stock-adjustments · create', () => {
  it('writes an approved row by default', async () => {
    const res = await app('inventory:create').request(
      base,
      json({
        productId: 'prod_1',
        warehouseId: 'wh_1',
        type: 'damage',
        previousQuantity: 10,
        adjustmentQuantity: -2,
        newQuantity: 8,
        reason: 'Dropped',
        reasonCode: 'DAMAGE',
        metadata: { pallet: 4 },
        sourceId: null,
      }),
    );
    expect(res.status).toBe(201);
  });

  it('marks a row that needs approval as pending', async () => {
    const res = await app('inventory:create').request(
      base,
      json({
        productId: 'prod_1',
        type: 'correction',
        previousQuantity: 8,
        adjustmentQuantity: 1,
        newQuantity: 9,
        requiresApproval: true,
        lotNumber: 'L1',
        performedBy: 'user_x',
        performedByName: 'X',
        sourceType: 'manual',
        sourceNumber: 'M-1',
      }),
    );
    expect(res.status).toBe(201);
  });

  it('refuses an invalid body', async () => {
    const { request } = app('inventory:create');
    for (const body of [
      {},
      { productId: '', type: 'x', previousQuantity: 1, adjustmentQuantity: 1, newQuantity: 1 },
      { productId: 'p', type: 'x', previousQuantity: 1.5, adjustmentQuantity: 1, newQuantity: 1 },
      { productId: 'p', type: 'x', previousQuantity: 1, adjustmentQuantity: 1, newQuantity: 1, requiresApproval: 'yes' },
      { productId: 'p', type: 'x', previousQuantity: 1, adjustmentQuantity: 1, newQuantity: 1, metadata: [1] },
    ]) {
      expect((await request(base, json(body))).status).toBe(400);
    }
  });

  it('answers its 500 when the row cannot be stored', async () => {
    const res = await app('inventory:create').request(
      base,
      json({ productId: 'p', type: 'x', previousQuantity: 3000000000, adjustmentQuantity: 1, newQuantity: 1 }),
    );
    expect(res.status).toBe(500);
  });

  it('needs inventory:create', async () => {
    const res = await app('inventory:read').request(
      base,
      json({ productId: 'p', type: 'x', previousQuantity: 1, adjustmentQuantity: 1, newQuantity: 1 }),
    );
    expect(res.status).toBe(403);
  });
});
