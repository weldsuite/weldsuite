import type { InventoryRow } from '@weldsuite/app-api-client/domains/inventory';
import type { ProductRow } from '@weldsuite/app-api-client/domains/products';

export const OPTIMISTIC_STOCK_PREFIX = 'optimistic:';

export function warehouseOnHand(rows: InventoryRow[], warehouseId: string | null): number {
  if (!warehouseId) return 0;
  return rows
    .filter((row) => row.warehouseId === warehouseId)
    .reduce((sum, row) => sum + (row.quantityOnHand ?? 0), 0);
}

/** Drop a decrease that would take on-hand below zero. Increases pass through. */
export function clampDelta(onHand: number, delta: number): number {
  if (delta === 0) return 0;
  if (delta > 0) return delta;
  if (onHand <= 0) return 0;
  return Math.max(delta, -onHand);
}

export function bumpProductQty(product: ProductRow, delta: number): ProductRow {
  return {
    ...product,
    inventoryQuantity: (product.inventoryQuantity ?? 0) + delta,
  };
}

export function makeOptimisticStockRow(input: {
  productId: string;
  warehouseId: string;
  quantityOnHand: number;
}): InventoryRow {
  const now = new Date().toISOString();
  return {
    id: `${OPTIMISTIC_STOCK_PREFIX}${input.productId}:${input.warehouseId}`,
    productId: input.productId,
    warehouseId: input.warehouseId,
    quantityOnHand: input.quantityOnHand,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply a signed delta to the first matching warehouse bucket. Creates an
 * optimistic row when the product has no stock there yet (first receipt).
 */
export function bumpInventoryRows(
  rows: InventoryRow[],
  productId: string,
  warehouseId: string,
  delta: number,
): InventoryRow[] {
  const index = rows.findIndex((row) => row.warehouseId === warehouseId);
  if (index === -1) {
    if (delta <= 0) return rows;
    return [...rows, makeOptimisticStockRow({ productId, warehouseId, quantityOnHand: delta })];
  }

  const next = rows.slice();
  const row = next[index];
  next[index] = {
    ...row,
    quantityOnHand: (row.quantityOnHand ?? 0) + delta,
  };
  return next;
}

export type AdjustFlushFn = (delta: number, warehouseId: string) => Promise<void>;

interface PendingBucket {
  warehouseId: string;
  delta: number;
}

/**
 * Coalesce rapid +/- taps into one ledger write per warehouse. `enqueue`
 * returns immediately; `flush` runs after `delayMs` of idle (or immediately
 * via `flushNow`). Taps that arrive while a request is in flight accumulate
 * and flush next. Switching warehouse starts a new bucket so the wrong
 * warehouse never receives the pending delta.
 *
 * Errors inside `flush` are swallowed so later buckets still send — the
 * caller is expected to roll back UI for the failed delta.
 */
export function createPendingAdjustQueue(flush: AdjustFlushFn, delayMs = 180) {
  const buckets: PendingBucket[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let busy = false;
  let draining: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const pendingTotal = () => buckets.reduce((sum, bucket) => sum + bucket.delta, 0);

  const drain = () => {
    draining = draining.then(async () => {
      while (buckets.length > 0) {
        const next = buckets.shift();
        if (!next || next.delta === 0) continue;
        busy = true;
        try {
          await flush(next.delta, next.warehouseId);
        } catch {
          // Caller reports the error and rolls back. Keep draining.
        } finally {
          busy = false;
        }
      }
    });
    return draining;
  };

  return {
    enqueue(delta: number, warehouseId: string) {
      if (disposed || delta === 0) return;
      const last = buckets[buckets.length - 1];
      if (last && last.warehouseId === warehouseId) {
        last.delta += delta;
      } else {
        buckets.push({ warehouseId, delta });
      }
      clearTimer();
      timer = setTimeout(() => {
        void drain();
      }, delayMs);
    },
    flushNow() {
      clearTimer();
      return drain();
    },
    getPending() {
      return pendingTotal();
    },
    isBusy() {
      return busy || buckets.length > 0;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

export type PendingAdjustQueue = ReturnType<typeof createPendingAdjustQueue>;
