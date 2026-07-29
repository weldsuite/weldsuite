/**
 * DB-backed tests for the inventory ledger.
 *
 * These run against pglite with the real tenant migrations, so the SQL the
 * ledger leans on (in-database increments, the moving-average CASE, the
 * roll-up subqueries) is exercised as Postgres will actually run it — the
 * parts most likely to be wrong are the parts a mocked DB would hide.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { applyStockChange, StockLedgerError, transferStock } from './inventory-ledger';

let db: Database;

const WAREHOUSE_A = 'wh_a';
const WAREHOUSE_B = 'wh_b';

/** Insert a product and return its id. Defaults to untracked, no backorder. */
async function makeProduct(
  overrides: Partial<typeof schema.products.$inferInsert> = {},
): Promise<string> {
  const id = generateId('prod');
  await db.insert(schema.products).values({
    id,
    name: `Product ${id}`,
    slug: id,
    sku: id.toUpperCase(),
    price: '10.00',
    trackInventory: true,
    allowBackorder: false,
    ...overrides,
  });
  return id;
}

async function bucketFor(productId: string, warehouseId: string) {
  const [row] = await db
    .select()
    .from(schema.inventory)
    .where(
      and(
        eq(schema.inventory.productId, productId),
        eq(schema.inventory.warehouseId, warehouseId),
        isNull(schema.inventory.deletedAt),
      ),
    )
    .limit(1);
  return row;
}

async function productQuantity(productId: string) {
  const [row] = await db
    .select({ q: schema.products.inventoryQuantity })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  return row?.q ?? 0;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('applyStockChange', () => {
  it('creates the bucket on first receipt and rolls the quantity up to the product', async () => {
    const productId = await makeProduct();

    const result = await applyStockChange(db, {
      productId,
      warehouseId: WAREHOUSE_A,
      delta: 10,
      type: 'received',
      reason: 'Initial receipt',
    });

    expect(result.previousQuantity).toBe(0);
    expect(result.newQuantity).toBe(10);
    expect(result.productQuantity).toBe(10);

    const bucket = await bucketFor(productId, WAREHOUSE_A);
    expect(bucket?.quantityOnHand).toBe(10);
    expect(bucket?.quantityAvailable).toBe(10);
    expect(await productQuantity(productId)).toBe(10);
  });

  it('writes an audit row for every change', async () => {
    const productId = await makeProduct();
    const { adjustmentId } = await applyStockChange(db, {
      productId,
      warehouseId: WAREHOUSE_A,
      delta: 7,
      type: 'received',
      reason: 'Goods in',
      reasonCode: 'RECEIVED',
    });

    const [audit] = await db
      .select()
      .from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.id, adjustmentId))
      .limit(1);

    expect(audit?.previousQuantity).toBe(0);
    expect(audit?.adjustmentQuantity).toBe(7);
    expect(audit?.newQuantity).toBe(7);
    expect(audit?.reasonCode).toBe('RECEIVED');
  });

  it('adds to the existing bucket rather than creating a second one', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 5, type: 'received' });
    const second = await applyStockChange(db, {
      productId,
      warehouseId: WAREHOUSE_A,
      delta: 3,
      type: 'received',
    });

    expect(second.previousQuantity).toBe(5);
    expect(second.newQuantity).toBe(8);

    const all = await db
      .select()
      .from(schema.inventory)
      .where(eq(schema.inventory.productId, productId));
    expect(all).toHaveLength(1);
  });

  it('keeps concurrent adjustments from losing each other', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 100, type: 'received' });

    // Ten interleaved +1s. A read-modify-write would land somewhere well short
    // of 110; the in-database increment must reach it exactly.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        applyStockChange(db, {
          productId,
          warehouseId: WAREHOUSE_A,
          delta: 1,
          type: 'increase',
          reason: 'concurrent',
        }),
      ),
    );

    const bucket = await bucketFor(productId, WAREHOUSE_A);
    expect(bucket?.quantityOnHand).toBe(110);
    expect(await productQuantity(productId)).toBe(110);
  });

  it('refuses to oversell a product that disallows backorder', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 3, type: 'received' });

    await expect(
      applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: -5, type: 'shipped' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    const bucket = await bucketFor(productId, WAREHOUSE_A);
    expect(bucket?.quantityOnHand).toBe(3);
  });

  it('lets stock go negative when the product allows backorder', async () => {
    const productId = await makeProduct({ allowBackorder: true });
    const result = await applyStockChange(db, {
      productId,
      warehouseId: WAREHOUSE_A,
      delta: -4,
      type: 'shipped',
    });
    expect(result.newQuantity).toBe(-4);
  });

  it('rejects an issue against a bucket that does not exist', async () => {
    const productId = await makeProduct();
    await expect(
      applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: -1, type: 'shipped' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('requires a lot number on receipt for a lot-tracked product', async () => {
    const productId = await makeProduct({ trackLots: true });

    await expect(
      applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 5, type: 'received' }),
    ).rejects.toMatchObject({ code: 'LOT_REQUIRED' });

    const ok = await applyStockChange(db, {
      productId,
      warehouseId: WAREHOUSE_A,
      delta: 5,
      type: 'received',
      lotNumber: 'LOT-1',
    });
    expect(ok.newQuantity).toBe(5);
  });

  it('does not demand a lot on the way out, so pre-existing stock stays correctable', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 5, type: 'received' });
    // Product opts into lot tracking only after stock already exists.
    await db.update(schema.products).set({ trackLots: true }).where(eq(schema.products.id, productId));

    const result = await applyStockChange(db, {
      productId,
      warehouseId: WAREHOUSE_A,
      delta: -2,
      type: 'correction',
    });
    expect(result.newQuantity).toBe(3);
  });

  it('treats a lot as part of the bucket identity', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, {
      productId, warehouseId: WAREHOUSE_A, delta: 4, type: 'received', lotNumber: 'L1',
    });
    await applyStockChange(db, {
      productId, warehouseId: WAREHOUSE_A, delta: 6, type: 'received', lotNumber: 'L2',
    });

    const rows = await db
      .select()
      .from(schema.inventory)
      .where(eq(schema.inventory.productId, productId));
    expect(rows).toHaveLength(2);
    // The roll-up spans every lot.
    expect(await productQuantity(productId)).toBe(10);
  });

  it('weights unit cost across receipts and leaves it alone on issue', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, {
      productId, warehouseId: WAREHOUSE_A, delta: 10, type: 'received', unitCost: 2,
    });
    // 10 @ 2.00 + 10 @ 4.00 → 3.00
    await applyStockChange(db, {
      productId, warehouseId: WAREHOUSE_A, delta: 10, type: 'received', unitCost: 4,
    });

    let bucket = await bucketFor(productId, WAREHOUSE_A);
    expect(Number(bucket?.unitCost)).toBeCloseTo(3, 2);
    expect(Number(bucket?.totalValue)).toBeCloseTo(60, 2);

    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: -5, type: 'shipped' });
    bucket = await bucketFor(productId, WAREHOUSE_A);
    expect(Number(bucket?.unitCost)).toBeCloseTo(3, 2);
    expect(Number(bucket?.totalValue)).toBeCloseTo(45, 2);
  });

  it('rejects a zero delta', async () => {
    const productId = await makeProduct();
    await expect(
      applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 0, type: 'correction' }),
    ).rejects.toBeInstanceOf(StockLedgerError);
  });

  it('rejects an unknown product', async () => {
    await expect(
      applyStockChange(db, { productId: 'prod_nope', warehouseId: WAREHOUSE_A, delta: 1, type: 'received' }),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
  });
});

describe('transferStock', () => {
  it('moves stock between warehouses without changing the total', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 20, type: 'received' });

    const result = await transferStock(db, {
      productId,
      quantity: 8,
      from: { warehouseId: WAREHOUSE_A },
      to: { warehouseId: WAREHOUSE_B },
      reason: 'Rebalance',
    });

    expect(result.out.newQuantity).toBe(12);
    expect(result.in.newQuantity).toBe(8);
    expect((await bucketFor(productId, WAREHOUSE_A))?.quantityOnHand).toBe(12);
    expect((await bucketFor(productId, WAREHOUSE_B))?.quantityOnHand).toBe(8);
    // The roll-up counts each unit once, wherever it sits.
    expect(await productQuantity(productId)).toBe(20);
  });

  it('records the movement and both audit legs', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 5, type: 'received' });

    const { movementId, movementNumber } = await transferStock(db, {
      productId,
      quantity: 5,
      from: { warehouseId: WAREHOUSE_A },
      to: { warehouseId: WAREHOUSE_B },
    });

    const [movement] = await db
      .select()
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.id, movementId))
      .limit(1);
    expect(movement?.movementType).toBe('transfer');
    expect(movement?.status).toBe('completed');
    expect(movement?.quantity).toBe(5);

    const legs = await db
      .select()
      .from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.sourceNumber, movementNumber));
    expect(legs.map((l) => l.type).sort()).toEqual(['transfer_in', 'transfer_out']);
  });

  it('leaves stock untouched when the source cannot cover the transfer', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 2, type: 'received' });

    await expect(
      transferStock(db, {
        productId,
        quantity: 5,
        from: { warehouseId: WAREHOUSE_A },
        to: { warehouseId: WAREHOUSE_B },
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    expect((await bucketFor(productId, WAREHOUSE_A))?.quantityOnHand).toBe(2);
    expect(await bucketFor(productId, WAREHOUSE_B)).toBeUndefined();
  });

  it('rejects a transfer to the same bucket', async () => {
    const productId = await makeProduct();
    await applyStockChange(db, { productId, warehouseId: WAREHOUSE_A, delta: 5, type: 'received' });

    await expect(
      transferStock(db, {
        productId,
        quantity: 1,
        from: { warehouseId: WAREHOUSE_A },
        to: { warehouseId: WAREHOUSE_A },
      }),
    ).rejects.toMatchObject({ code: 'SAME_LOCATION' });
  });

  it('rejects a non-positive quantity', async () => {
    const productId = await makeProduct();
    await expect(
      transferStock(db, {
        productId,
        quantity: 0,
        from: { warehouseId: WAREHOUSE_A },
        to: { warehouseId: WAREHOUSE_B },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DELTA' });
  });
});
