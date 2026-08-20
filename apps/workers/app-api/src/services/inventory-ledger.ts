/**
 * Inventory ledger — the single write path for stock quantities.
 *
 * Every change to `inventory.quantity_on_hand` goes through this module so that
 * four things stay true at once:
 *
 *   1. `inventory` rows (per warehouse / location / lot) are the source of
 *      truth. `products.inventory_quantity` and
 *      `product_variants.inventory_quantity` are roll-ups recomputed from them
 *      on every change, never written independently.
 *   2. Every change leaves an audit row in `stock_adjustments`.
 *   3. Quantities move under concurrency without lost updates.
 *   4. `quantity_available` stays equal to `quantity_on_hand - quantity_allocated`.
 *
 * ## Concurrency
 *
 * The naive read-modify-write (`SELECT`, add in JS, `UPDATE ... SET qty = 12`)
 * loses updates when two adjustments race. Instead the increment happens inside
 * the database (`SET quantity_on_hand = quantity_on_hand + $delta`) and
 * `RETURNING` hands back the post-update row. The previous quantity needed for
 * the audit trail is derived as `new - delta`, which stays exact no matter how
 * many writers interleave.
 *
 * Creating a bucket is the other half of that: an increment that matches
 * nothing falls through to an insert, and two first receipts for the same key
 * would race there. `inventory_bucket_unique` (partial, NULLS NOT DISTINCT)
 * settles it — the loser's insert is a no-op and it re-runs the increment
 * against the winner's row.
 *
 * ## Atomicity
 *
 * The tenant DB is neon-http, which has no interactive transactions
 * (`db.transaction()` throws "No transactions support"). It does have
 * `db.batch()`, which Neon executes as a single transaction in one HTTP
 * request. Writes that must land together go through `lib/atomically`, which
 * picks whichever the driver has.
 *
 * The one thing a batch cannot express is "update, and insert only if the
 * update matched nothing" — that needs the update's result first. So a stock
 * change is at most two round-trips: the quantity write, then a batch holding
 * the audit row plus the roll-up recomputation.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';
import { atomically } from '../lib/atomically';
import { generateId } from '../lib/id';

const { inventory, products, productVariants, stockAdjustments, inventoryMovements } = schema;

/**
 * Adjustment types accepted by the ledger. Mirrors the `type` column on
 * `stock_adjustments`.
 */
export type StockAdjustmentType =
  | 'increase'
  | 'decrease'
  | 'correction'
  | 'damage'
  | 'return'
  | 'transfer_in'
  | 'transfer_out'
  | 'received'
  | 'shipped'
  | 'cycle_count';

/** Identifies exactly one `inventory` row: the natural key of a stock bucket. */
export interface StockKey {
  productId: string;
  warehouseId: string;
  variantId?: string | null;
  locationId?: string | null;
  lotNumber?: string | null;
}

export interface StockChangeParams extends StockKey {
  /** Signed change in units. Negative issues stock, positive receives it. */
  delta: number;
  type: StockAdjustmentType;
  reason?: string | null;
  reasonCode?: string | null;
  notes?: string | null;
  /** Unit cost of the incoming units. Only used when `delta > 0`. */
  unitCost?: number | null;
  batchNumber?: string | null;
  expiryDate?: Date | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceNumber?: string | null;
  performedBy?: string | null;
  performedByName?: string | null;
}

export interface StockChangeResult {
  inventoryId: string;
  adjustmentId: string;
  previousQuantity: number;
  newQuantity: number;
  /** Post-change roll-up on the product, after the recompute. */
  productQuantity: number;
}

/**
 * Raised for conditions the caller can fix — unknown product, insufficient
 * stock, a missing lot number on a lot-tracked product. Routes map this to a
 * 400; anything else bubbles up as a 500.
 */
export class StockLedgerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PRODUCT_NOT_FOUND'
      | 'INSUFFICIENT_STOCK'
      | 'INSUFFICIENT_AVAILABLE'
      | 'INSUFFICIENT_ALLOCATION'
      | 'LOT_REQUIRED'
      | 'EXPIRY_REQUIRED'
      | 'INVALID_DELTA'
      | 'SAME_LOCATION',
  ) {
    super(message);
    this.name = 'StockLedgerError';
  }
}

/**
 * Match exactly one stock bucket.
 *
 * A null `locationId` / `variantId` / `lotNumber` means "the bucket that also
 * has none", not "any bucket" — so these compare with `IS NULL` rather than
 * being dropped from the predicate. Getting this wrong is how unlocated stock
 * silently merges with located stock.
 */
function matchStockKey(key: StockKey) {
  return and(
    eq(inventory.productId, key.productId),
    eq(inventory.warehouseId, key.warehouseId),
    key.variantId ? eq(inventory.variantId, key.variantId) : isNull(inventory.variantId),
    key.locationId ? eq(inventory.locationId, key.locationId) : isNull(inventory.locationId),
    key.lotNumber ? eq(inventory.lotNumber, key.lotNumber) : isNull(inventory.lotNumber),
    isNull(inventory.deletedAt),
  );
}

/**
 * Weighted-average unit cost after receiving `delta` units at `unitCost`.
 *
 * Evaluated in SQL against the pre-update row, so it composes with the atomic
 * increment. Issues (`delta <= 0`) and receipts with no stated cost leave the
 * running average untouched — that is what makes it a moving average rather
 * than a last-cost field.
 *
 * `GREATEST(quantity_on_hand, 0)` keeps a negative on-hand (oversold stock)
 * from inverting the weighting.
 *
 * The value of the incoming units is multiplied out here rather than in SQL:
 * `$delta * $unitCost` is two bare parameters, and Postgres rejects
 * `unknown * unknown` as an ambiguous operator. The remaining parameters carry
 * explicit `::numeric` casts for the same reason.
 */
function movingAverageCost(delta: number, unitCost: number | null | undefined) {
  if (delta <= 0 || unitCost === null || unitCost === undefined) {
    return sql`${inventory.unitCost}`;
  }
  const receiptValue = delta * unitCost;
  return sql`ROUND(
    (GREATEST(${inventory.quantityOnHand}, 0) * COALESCE(${inventory.unitCost}, ${unitCost}::numeric)
      + ${receiptValue}::numeric)
    / NULLIF(GREATEST(${inventory.quantityOnHand}, 0) + ${delta}::numeric, 0)
  , 2)`;
}

/**
 * Recompute the denormalised roll-ups from the inventory rows.
 *
 * Derived rather than incremented: an incremented counter drifts the moment any
 * write path forgets to call it, whereas a recompute is self-healing. Returned
 * as lazy builders so the caller can batch them with the audit row.
 */
function rollUpStatements(db: Database, productId: string, variantId: string | null | undefined, now: Date) {
  const statements: unknown[] = [
    db
      .update(products)
      .set({
        inventoryQuantity: sql`(
          SELECT COALESCE(SUM(${inventory.quantityOnHand}), 0)
          FROM ${inventory}
          WHERE ${inventory.productId} = ${productId} AND ${inventory.deletedAt} IS NULL
        )`,
        updatedAt: now,
      })
      .where(eq(products.id, productId)),
  ];

  if (variantId) {
    statements.push(
      db
        .update(productVariants)
        .set({
          inventoryQuantity: sql`(
            SELECT COALESCE(SUM(${inventory.quantityOnHand}), 0)
            FROM ${inventory}
            WHERE ${inventory.variantId} = ${variantId} AND ${inventory.deletedAt} IS NULL
          )`,
          updatedAt: now,
        })
        .where(eq(productVariants.id, variantId)),
    );
  }

  return statements;
}

/**
 * Apply a signed stock change to one bucket, writing the audit trail and
 * refreshing the product roll-ups.
 *
 * Returns the exact before/after quantities for that bucket even under
 * concurrent writers.
 *
 * @throws {StockLedgerError} for caller-fixable conditions (see the class).
 */
export async function applyStockChange(
  db: Database,
  params: StockChangeParams,
): Promise<StockChangeResult> {
  if (params.delta === 0) {
    throw new StockLedgerError('Adjustment delta must not be zero', 'INVALID_DELTA');
  }

  const now = new Date();

  const [product] = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      trackLots: products.trackLots,
      trackExpiry: products.trackExpiry,
      allowBackorder: products.allowBackorder,
    })
    .from(products)
    .where(and(eq(products.id, params.productId), isNull(products.deletedAt)))
    .limit(1);

  if (!product) {
    throw new StockLedgerError(`Product ${params.productId} not found`, 'PRODUCT_NOT_FOUND');
  }

  // Traceability is enforced only on receipt. Demanding a lot on the way out
  // would block correcting stock that predates the product opting in.
  if (params.delta > 0) {
    if (product.trackLots && !params.lotNumber) {
      throw new StockLedgerError(
        `Product ${product.sku ?? product.id} is lot-tracked — lotNumber is required when receiving stock`,
        'LOT_REQUIRED',
      );
    }
    if (product.trackExpiry && !params.expiryDate) {
      throw new StockLedgerError(
        `Product ${product.sku ?? product.id} is expiry-tracked — expiryDate is required when receiving stock`,
        'EXPIRY_REQUIRED',
      );
    }
  }

  const costExpr = movingAverageCost(params.delta, params.unitCost);

  // The increment runs server-side, so concurrent adjustments compose instead
  // of overwriting each other. On an issue, `quantity_on_hand >= -delta` is part
  // of the predicate: the row simply doesn't match when the stock isn't there,
  // which both rejects the oversell and prevents it atomically.
  const guard =
    params.delta < 0 && !product.allowBackorder
      ? and(matchStockKey(params), sql`${inventory.quantityOnHand} >= ${-params.delta}`)
      : matchStockKey(params);

  const increment = () =>
    db
      .update(inventory)
      .set({
        quantityOnHand: sql`${inventory.quantityOnHand} + ${params.delta}`,
        quantityAvailable: sql`${inventory.quantityOnHand} + ${params.delta} - COALESCE(${inventory.quantityAllocated}, 0)`,
        unitCost: costExpr,
        totalValue: sql`ROUND(COALESCE(${costExpr}, 0) * (${inventory.quantityOnHand} + ${params.delta}::numeric), 2)`,
        expiryDate: params.expiryDate ?? sql`${inventory.expiryDate}`,
        receivedDate: params.delta > 0 ? now : sql`${inventory.receivedDate}`,
        updatedAt: now,
      })
      .where(guard)
      .returning({ id: inventory.id, quantityOnHand: inventory.quantityOnHand });

  const updated = await increment();

  let inventoryId: string;
  let newQuantity: number;

  if (updated.length > 0) {
    inventoryId = updated[0].id;
    newQuantity = updated[0].quantityOnHand ?? 0;
  } else {
    // No row matched. Either the bucket doesn't exist yet, or it does and the
    // oversell guard rejected the issue. Distinguish the two, because creating
    // a bucket at a negative quantity to satisfy an issue would invent stock.
    const [existing] = await db
      .select({ id: inventory.id, quantityOnHand: inventory.quantityOnHand })
      .from(inventory)
      .where(matchStockKey(params))
      .limit(1);

    if (existing) {
      throw new StockLedgerError(
        `Insufficient stock: ${existing.quantityOnHand ?? 0} on hand, ${-params.delta} requested`,
        'INSUFFICIENT_STOCK',
      );
    }
    if (params.delta < 0 && !product.allowBackorder) {
      throw new StockLedgerError(
        `Insufficient stock: 0 on hand, ${-params.delta} requested`,
        'INSUFFICIENT_STOCK',
      );
    }

    // Creating the bucket is the one check-then-act left in this path: two
    // simultaneous first receipts both find no row and both insert. Deferring
    // to `inventory_bucket_unique` makes the insert idempotent — the loser gets
    // no row back and simply applies its delta to the winner's bucket instead,
    // which is what it would have done had it arrived a moment later.
    const candidateId = generateId('inv');
    const created = await db
      .insert(inventory)
      .values({
        id: candidateId,
        productId: params.productId,
        variantId: params.variantId ?? null,
        warehouseId: params.warehouseId,
        locationId: params.locationId ?? null,
        lotNumber: params.lotNumber ?? null,
        batchNumber: params.batchNumber ?? null,
        expiryDate: params.expiryDate ?? null,
        quantityOnHand: params.delta,
        quantityAllocated: 0,
        quantityAvailable: params.delta,
        quantityIncoming: 0,
        quantityOutgoing: 0,
        unitCost: params.unitCost !== null && params.unitCost !== undefined ? String(params.unitCost) : null,
        totalValue:
          params.unitCost !== null && params.unitCost !== undefined
            ? String((params.unitCost * params.delta).toFixed(2))
            : null,
        status: 'available',
        receivedDate: params.delta > 0 ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          inventory.productId,
          inventory.warehouseId,
          inventory.variantId,
          inventory.locationId,
          inventory.lotNumber,
        ],
        // On `onConflictDoNothing` this renders as the ON CONFLICT (…) WHERE …
        // predicate, which is what names the partial index as the arbiter —
        // without it Postgres cannot infer which index is meant.
        where: sql`${inventory.deletedAt} IS NULL`,
      })
      .returning({ id: inventory.id, quantityOnHand: inventory.quantityOnHand });

    if (created.length > 0) {
      inventoryId = created[0].id;
      newQuantity = created[0].quantityOnHand ?? params.delta;
    } else {
      const retried = await increment();
      if (retried.length === 0) {
        // The concurrent creator's bucket exists but can't absorb this issue.
        const [raced] = await db
          .select({ quantityOnHand: inventory.quantityOnHand })
          .from(inventory)
          .where(matchStockKey(params))
          .limit(1);
        throw new StockLedgerError(
          `Insufficient stock: ${raced?.quantityOnHand ?? 0} on hand, ${-params.delta} requested`,
          'INSUFFICIENT_STOCK',
        );
      }
      inventoryId = retried[0].id;
      newQuantity = retried[0].quantityOnHand ?? 0;
    }
  }

  const previousQuantity = newQuantity - params.delta;
  const adjustmentId = generateId('adj');

  await atomically(db, (handle) => [
    handle.insert(stockAdjustments).values({
      id: adjustmentId,
      productId: params.productId,
      variantId: params.variantId ?? null,
      warehouseId: params.warehouseId,
      locationId: params.locationId ?? null,
      inventoryId,
      type: params.type,
      previousQuantity,
      adjustmentQuantity: params.delta,
      newQuantity,
      lotNumber: params.lotNumber ?? null,
      batchNumber: params.batchNumber ?? null,
      reason: params.reason ?? null,
      reasonCode: params.reasonCode ?? null,
      notes: params.notes ?? null,
      performedBy: params.performedBy ?? null,
      performedByName: params.performedByName ?? null,
      sourceType: params.sourceType ?? 'manual',
      sourceId: params.sourceId ?? null,
      sourceNumber: params.sourceNumber ?? null,
      requiresApproval: 0,
      approvalStatus: 'approved',
      createdAt: now,
    }),
    ...rollUpStatements(handle, params.productId, params.variantId, now),
  ]);

  const [rolled] = await db
    .select({ inventoryQuantity: products.inventoryQuantity })
    .from(products)
    .where(eq(products.id, params.productId))
    .limit(1);

  return {
    inventoryId,
    adjustmentId,
    previousQuantity,
    newQuantity,
    productQuantity: rolled?.inventoryQuantity ?? 0,
  };
}

export interface TransferParams {
  productId: string;
  variantId?: string | null;
  quantity: number;
  from: { warehouseId: string; locationId?: string | null; lotNumber?: string | null };
  to: { warehouseId: string; locationId?: string | null; lotNumber?: string | null };
  reason?: string | null;
  notes?: string | null;
  performedBy?: string | null;
  performedByName?: string | null;
}

export interface TransferResult {
  movementId: string;
  movementNumber: string;
  out: StockChangeResult;
  in: StockChangeResult;
}

/**
 * Move stock between two buckets and record it as one `inventory_movements` row.
 *
 * The two legs cannot share a transaction — the credit's parameters depend on
 * the debit having succeeded, and neon-http gives us no open transaction to
 * hold across that. So the debit runs first (it is the leg that can legitimately
 * fail, on insufficient stock) and, if the credit then fails, the debit is
 * compensated before rethrowing. A failed compensation is logged loudly rather
 * than swallowed: at that point stock has genuinely gone missing and a human
 * needs to know.
 *
 * @throws {StockLedgerError} on same-bucket transfers or insufficient stock.
 */
export async function transferStock(db: Database, params: TransferParams): Promise<TransferResult> {
  if (params.quantity <= 0) {
    throw new StockLedgerError('Transfer quantity must be positive', 'INVALID_DELTA');
  }

  // An omitted destination lot means "keep the lot it came from", so the guard
  // has to compare the *resolved* destination. Comparing `to.lotNumber` raw let
  // A/L1 → A pass as a cross-bucket move and then debit and credit the same
  // bucket, leaving an offsetting pair plus a movement row for a no-op.
  const toLotNumber = params.to.lotNumber ?? params.from.lotNumber ?? null;
  const sameBucket =
    params.from.warehouseId === params.to.warehouseId &&
    (params.from.locationId ?? null) === (params.to.locationId ?? null) &&
    (params.from.lotNumber ?? null) === toLotNumber;
  if (sameBucket) {
    throw new StockLedgerError('Source and destination are the same location', 'SAME_LOCATION');
  }

  const now = new Date();
  const movementId = generateId('mov');
  // The timestamp alone collides for transfers started in the same
  // millisecond, and `sourceNumber` is how the two audit legs are tied back to
  // this movement — so the id, which is already unique, disambiguates it.
  const movementNumber = `TRF-${now.getTime().toString(36).toUpperCase()}-${movementId.slice(-6).toUpperCase()}`;

  const outResult = await applyStockChange(db, {
    productId: params.productId,
    variantId: params.variantId,
    warehouseId: params.from.warehouseId,
    locationId: params.from.locationId,
    lotNumber: params.from.lotNumber,
    delta: -params.quantity,
    type: 'transfer_out',
    reason: params.reason,
    notes: params.notes,
    sourceType: 'transfer',
    sourceId: movementId,
    sourceNumber: movementNumber,
    performedBy: params.performedBy,
    performedByName: params.performedByName,
  });

  let inResult: StockChangeResult;
  try {
    inResult = await applyStockChange(db, {
      productId: params.productId,
      variantId: params.variantId,
      warehouseId: params.to.warehouseId,
      locationId: params.to.locationId,
      lotNumber: toLotNumber,
      delta: params.quantity,
      type: 'transfer_in',
      reason: params.reason,
      notes: params.notes,
      sourceType: 'transfer',
      sourceId: movementId,
      sourceNumber: movementNumber,
      performedBy: params.performedBy,
      performedByName: params.performedByName,
    });
  } catch (err) {
    try {
      await applyStockChange(db, {
        productId: params.productId,
        variantId: params.variantId,
        warehouseId: params.from.warehouseId,
        locationId: params.from.locationId,
        lotNumber: params.from.lotNumber,
        delta: params.quantity,
        type: 'correction',
        reason: `Compensating reversal for failed transfer ${movementNumber}`,
        sourceType: 'transfer',
        sourceId: movementId,
        sourceNumber: movementNumber,
        performedBy: params.performedBy,
        performedByName: params.performedByName,
      });
    } catch (compensationErr) {
      console.error(
        `[inventory-ledger] transfer ${movementNumber} failed AND compensation failed — ` +
          `${params.quantity} units of ${params.productId} are debited from ` +
          `${params.from.warehouseId}/${params.from.locationId ?? 'unlocated'} with no matching credit:`,
        compensationErr,
      );
    }
    throw err;
  }

  const [product] = await db
    .select({ name: products.name, sku: products.sku })
    .from(products)
    .where(eq(products.id, params.productId))
    .limit(1);

  await db.insert(inventoryMovements).values({
    id: movementId,
    movementNumber,
    movementType: 'transfer',
    status: 'completed',
    sourceWarehouseId: params.from.warehouseId,
    sourceLocationId: params.from.locationId ?? null,
    destWarehouseId: params.to.warehouseId,
    destLocationId: params.to.locationId ?? null,
    productId: params.productId,
    variantId: params.variantId ?? null,
    sku: product?.sku ?? null,
    name: product?.name ?? null,
    quantity: params.quantity,
    lotNumber: params.from.lotNumber ?? null,
    sourceType: 'manual',
    reason: params.reason ?? null,
    notes: params.notes ?? null,
    createdBy: params.performedBy ?? null,
    completedBy: params.performedBy ?? null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return { movementId, movementNumber, out: outResult, in: inResult };
}

export interface AllocationResult {
  inventoryId: string;
  previousAllocated: number;
  newAllocated: number;
  quantityOnHand: number;
  quantityAvailable: number;
}

/**
 * Reserve `quantity` units on a bucket. On-hand is unchanged; available
 * drops by the same amount (`on_hand - allocated`).
 */
export async function allocateStock(
  db: Database,
  params: { inventoryId: string; quantity: number },
): Promise<AllocationResult> {
  if (params.quantity <= 0) {
    throw new StockLedgerError('Allocation quantity must be positive', 'INVALID_DELTA');
  }

  const now = new Date();
  const updated = await db
    .update(inventory)
    .set({
      quantityAllocated: sql`COALESCE(${inventory.quantityAllocated}, 0) + ${params.quantity}`,
      quantityAvailable: sql`${inventory.quantityOnHand} - (COALESCE(${inventory.quantityAllocated}, 0) + ${params.quantity})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(inventory.id, params.inventoryId),
        isNull(inventory.deletedAt),
        sql`${inventory.quantityOnHand} - COALESCE(${inventory.quantityAllocated}, 0) >= ${params.quantity}`,
      ),
    )
    .returning({
      id: inventory.id,
      quantityOnHand: inventory.quantityOnHand,
      quantityAllocated: inventory.quantityAllocated,
      quantityAvailable: inventory.quantityAvailable,
    });

  if (updated.length === 0) {
    const [existing] = await db
      .select({
        id: inventory.id,
        quantityOnHand: inventory.quantityOnHand,
        quantityAllocated: inventory.quantityAllocated,
      })
      .from(inventory)
      .where(and(eq(inventory.id, params.inventoryId), isNull(inventory.deletedAt)))
      .limit(1);
    if (!existing) {
      throw new StockLedgerError(`Inventory ${params.inventoryId} not found`, 'PRODUCT_NOT_FOUND');
    }
    const available = (existing.quantityOnHand ?? 0) - (existing.quantityAllocated ?? 0);
    throw new StockLedgerError(
      `Insufficient available stock: ${available} available, ${params.quantity} requested`,
      'INSUFFICIENT_AVAILABLE',
    );
  }

  const row = updated[0];
  const newAllocated = row.quantityAllocated ?? 0;
  return {
    inventoryId: row.id,
    previousAllocated: newAllocated - params.quantity,
    newAllocated,
    quantityOnHand: row.quantityOnHand ?? 0,
    quantityAvailable: row.quantityAvailable ?? 0,
  };
}

/**
 * Release a previous reservation. On-hand is unchanged; available rises.
 */
export async function releaseAllocation(
  db: Database,
  params: { inventoryId: string; quantity: number },
): Promise<AllocationResult> {
  if (params.quantity <= 0) {
    throw new StockLedgerError('Release quantity must be positive', 'INVALID_DELTA');
  }

  const now = new Date();
  const updated = await db
    .update(inventory)
    .set({
      quantityAllocated: sql`COALESCE(${inventory.quantityAllocated}, 0) - ${params.quantity}`,
      quantityAvailable: sql`${inventory.quantityOnHand} - (COALESCE(${inventory.quantityAllocated}, 0) - ${params.quantity})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(inventory.id, params.inventoryId),
        isNull(inventory.deletedAt),
        sql`COALESCE(${inventory.quantityAllocated}, 0) >= ${params.quantity}`,
      ),
    )
    .returning({
      id: inventory.id,
      quantityOnHand: inventory.quantityOnHand,
      quantityAllocated: inventory.quantityAllocated,
      quantityAvailable: inventory.quantityAvailable,
    });

  if (updated.length === 0) {
    const [existing] = await db
      .select({ quantityAllocated: inventory.quantityAllocated })
      .from(inventory)
      .where(and(eq(inventory.id, params.inventoryId), isNull(inventory.deletedAt)))
      .limit(1);
    throw new StockLedgerError(
      `Insufficient allocation: ${existing?.quantityAllocated ?? 0} allocated, ${params.quantity} to release`,
      'INSUFFICIENT_ALLOCATION',
    );
  }

  const row = updated[0];
  const newAllocated = row.quantityAllocated ?? 0;
  return {
    inventoryId: row.id,
    previousAllocated: newAllocated + params.quantity,
    newAllocated,
    quantityOnHand: row.quantityOnHand ?? 0,
    quantityAvailable: row.quantityAvailable ?? 0,
  };
}

export interface IssueAllocatedParams {
  inventoryId: string;
  quantity: number;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceNumber?: string | null;
  reason?: string | null;
  performedBy?: string | null;
  performedByName?: string | null;
}

/**
 * Convert a reservation into a shipment: decrement on-hand and allocated
 * together so available stays the same. Writes a `shipped` stock adjustment.
 */
export async function issueAllocatedStock(
  db: Database,
  params: IssueAllocatedParams,
): Promise<StockChangeResult> {
  if (params.quantity <= 0) {
    throw new StockLedgerError('Issue quantity must be positive', 'INVALID_DELTA');
  }

  const now = new Date();
  const updated = await db
    .update(inventory)
    .set({
      quantityOnHand: sql`${inventory.quantityOnHand} - ${params.quantity}`,
      quantityAllocated: sql`COALESCE(${inventory.quantityAllocated}, 0) - ${params.quantity}`,
      quantityAvailable: sql`(${inventory.quantityOnHand} - ${params.quantity}) - (COALESCE(${inventory.quantityAllocated}, 0) - ${params.quantity})`,
      totalValue: sql`ROUND(COALESCE(${inventory.unitCost}, 0) * (${inventory.quantityOnHand} - ${params.quantity}::numeric), 2)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(inventory.id, params.inventoryId),
        isNull(inventory.deletedAt),
        sql`${inventory.quantityOnHand} >= ${params.quantity}`,
        sql`COALESCE(${inventory.quantityAllocated}, 0) >= ${params.quantity}`,
      ),
    )
    .returning({
      id: inventory.id,
      productId: inventory.productId,
      variantId: inventory.variantId,
      warehouseId: inventory.warehouseId,
      locationId: inventory.locationId,
      lotNumber: inventory.lotNumber,
      quantityOnHand: inventory.quantityOnHand,
    });

  if (updated.length === 0) {
    const [existing] = await db
      .select({
        quantityOnHand: inventory.quantityOnHand,
        quantityAllocated: inventory.quantityAllocated,
      })
      .from(inventory)
      .where(and(eq(inventory.id, params.inventoryId), isNull(inventory.deletedAt)))
      .limit(1);
    if (!existing) {
      throw new StockLedgerError(`Inventory ${params.inventoryId} not found`, 'PRODUCT_NOT_FOUND');
    }
    if ((existing.quantityAllocated ?? 0) < params.quantity) {
      throw new StockLedgerError(
        `Insufficient allocation: ${existing.quantityAllocated ?? 0} allocated, ${params.quantity} to ship`,
        'INSUFFICIENT_ALLOCATION',
      );
    }
    throw new StockLedgerError(
      `Insufficient stock: ${existing.quantityOnHand ?? 0} on hand, ${params.quantity} requested`,
      'INSUFFICIENT_STOCK',
    );
  }

  const row = updated[0];
  const newQuantity = row.quantityOnHand ?? 0;
  const previousQuantity = newQuantity + params.quantity;
  const adjustmentId = generateId('adj');

  await atomically(db, (handle) => [
    handle.insert(stockAdjustments).values({
      id: adjustmentId,
      productId: row.productId,
      variantId: row.variantId ?? null,
      warehouseId: row.warehouseId,
      locationId: row.locationId ?? null,
      inventoryId: row.id,
      type: 'shipped',
      previousQuantity,
      adjustmentQuantity: -params.quantity,
      newQuantity,
      lotNumber: row.lotNumber ?? null,
      reason: params.reason ?? null,
      performedBy: params.performedBy ?? null,
      performedByName: params.performedByName ?? null,
      sourceType: params.sourceType ?? 'pick_list',
      sourceId: params.sourceId ?? null,
      sourceNumber: params.sourceNumber ?? null,
      requiresApproval: 0,
      approvalStatus: 'approved',
      createdAt: now,
    }),
    ...rollUpStatements(handle, row.productId, row.variantId, now),
  ]);

  const [rolled] = await db
    .select({ inventoryQuantity: products.inventoryQuantity })
    .from(products)
    .where(eq(products.id, row.productId))
    .limit(1);

  return {
    inventoryId: row.id,
    adjustmentId,
    previousQuantity,
    newQuantity,
    productQuantity: rolled?.inventoryQuantity ?? 0,
  };
}
