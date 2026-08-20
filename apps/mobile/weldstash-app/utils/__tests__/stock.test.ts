import { QueryClient } from '@tanstack/react-query';
import type { InventoryRow } from '@weldsuite/app-api-client/domains/inventory';
import type { ProductRow } from '@weldsuite/app-api-client/domains/products';
import { weldstashKeys } from '../../lib/query-client';
import { applyLocalStockDelta } from '../../lib/weldstash-cache';
import {
  bumpInventoryRows,
  bumpProductQty,
  clampDelta,
  createPendingAdjustQueue,
  OPTIMISTIC_STOCK_PREFIX,
  warehouseOnHand,
} from '../stock';

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 'prod_1',
    name: 'Widget',
    slug: 'widget',
    status: 'active',
    inventoryQuantity: 4,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    id: 'inv_1',
    productId: 'prod_1',
    warehouseId: 'wh_1',
    quantityOnHand: 3,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('clampDelta', () => {
  it('passes increases through', () => {
    expect(clampDelta(0, 5)).toBe(5);
  });

  it('blocks a decrease when nothing is on hand', () => {
    expect(clampDelta(0, -1)).toBe(0);
  });

  it('clamps a decrease to the on-hand quantity', () => {
    expect(clampDelta(2, -8)).toBe(-2);
  });
});

describe('warehouseOnHand', () => {
  it('sums matching warehouse rows', () => {
    const rows = [row({ quantityOnHand: 2 }), row({ id: 'inv_2', warehouseId: 'wh_2', quantityOnHand: 9 })];
    expect(warehouseOnHand(rows, 'wh_1')).toBe(2);
    expect(warehouseOnHand(rows, null)).toBe(0);
  });
});

describe('bumpInventoryRows', () => {
  it('increments the first matching warehouse bucket', () => {
    const next = bumpInventoryRows([row()], 'prod_1', 'wh_1', 2);
    expect(next[0].quantityOnHand).toBe(5);
  });

  it('creates an optimistic row on first receipt', () => {
    const next = bumpInventoryRows([], 'prod_1', 'wh_1', 1);
    expect(next).toHaveLength(1);
    expect(next[0].id).toMatch(new RegExp(`^${OPTIMISTIC_STOCK_PREFIX}`));
    expect(next[0].quantityOnHand).toBe(1);
  });

  it('does not invent a row for a decrease against empty stock', () => {
    expect(bumpInventoryRows([], 'prod_1', 'wh_1', -1)).toEqual([]);
  });
});

describe('bumpProductQty', () => {
  it('adds the delta to the product roll-up', () => {
    expect(bumpProductQty(product(), 3).inventoryQuantity).toBe(7);
  });
});

describe('createPendingAdjustQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for the idle delay before flushing', async () => {
    const flush = jest.fn().mockResolvedValue(undefined);
    const queue = createPendingAdjustQueue(flush, 180);

    queue.enqueue(1, 'wh_1');
    expect(flush).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(179);
    expect(flush).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(1, 'wh_1');
    queue.dispose();
  });

  it('coalesces rapid taps for the same warehouse into one flush', async () => {
    const flush = jest.fn().mockResolvedValue(undefined);
    const queue = createPendingAdjustQueue(flush, 180);

    queue.enqueue(1, 'wh_1');
    queue.enqueue(1, 'wh_1');
    queue.enqueue(1, 'wh_1');
    expect(flush).not.toHaveBeenCalled();

    await queue.flushNow();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(3, 'wh_1');
    queue.dispose();
  });

  it('keeps a separate bucket when the warehouse changes', async () => {
    const flush = jest.fn().mockResolvedValue(undefined);
    const queue = createPendingAdjustQueue(flush, 180);

    queue.enqueue(2, 'wh_1');
    queue.enqueue(1, 'wh_2');
    await queue.flushNow();

    expect(flush).toHaveBeenNthCalledWith(1, 2, 'wh_1');
    expect(flush).toHaveBeenNthCalledWith(2, 1, 'wh_2');
    queue.dispose();
  });

  it('rolls the next burst after an in-flight flush', async () => {
    let resolveFlush: (() => void) | undefined;
    const flush = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFlush = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = createPendingAdjustQueue(flush, 180);

    queue.enqueue(1, 'wh_1');
    const first = queue.flushNow();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);

    queue.enqueue(2, 'wh_1');
    resolveFlush?.();
    await first;

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(2, 2, 'wh_1');
    queue.dispose();
  });

  it('still drains later buckets when a flush rejects', async () => {
    const flush = jest
      .fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(undefined);
    const queue = createPendingAdjustQueue(flush, 180);

    queue.enqueue(1, 'wh_1');
    queue.enqueue(4, 'wh_2');
    await queue.flushNow();

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(2, 4, 'wh_2');
    queue.dispose();
  });
});

describe('applyLocalStockDelta', () => {
  it('patches product detail, product lists, and stock in the query cache', () => {
    const client = new QueryClient();
    const prod = product();
    client.setQueryData(weldstashKeys.product('prod_1'), { data: prod });
    client.setQueryData(weldstashKeys.productList(''), {
      data: [prod],
      pagination: { totalCount: 1, hasMore: false, cursor: null },
    });
    client.setQueryData(weldstashKeys.stock('prod_1'), {
      data: [row()],
      pagination: { totalCount: 1, hasMore: false, cursor: null },
    });

    applyLocalStockDelta(client, { productId: 'prod_1', warehouseId: 'wh_1', delta: 2 });

    expect(client.getQueryData(weldstashKeys.product('prod_1'))).toMatchObject({
      data: { inventoryQuantity: 6 },
    });
    expect(client.getQueryData(weldstashKeys.productList(''))).toMatchObject({
      data: [{ inventoryQuantity: 6 }],
    });
    expect(client.getQueryData(weldstashKeys.stock('prod_1'))).toMatchObject({
      data: [{ quantityOnHand: 5 }],
    });
  });
});
