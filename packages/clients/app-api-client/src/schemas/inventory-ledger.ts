import { z } from 'zod';

// ============================================================================
// Inventory ledger — the write surface for stock quantities.
//
// `inventory` rows (per warehouse / location / lot) are the source of truth;
// `products.inventory_quantity` is a roll-up the ledger recomputes. Every
// change lands in `stock_adjustments`, which is what `GET /api/inventory/ledger`
// reads back.
//
// Backed by apps/workers/app-api/src/services/inventory-ledger.ts.
// Permission prefix: `inventory:*`.
// ============================================================================

/** Mirrors `StockAdjustmentType` in the ledger service. */
export const stockAdjustmentTypeSchema = z.enum([
  'increase',
  'decrease',
  'correction',
  'damage',
  'return',
  'transfer_in',
  'transfer_out',
  'received',
  'shipped',
  'cycle_count',
]);

/**
 * Adjust one stock bucket by a signed delta.
 *
 * A superset of the legacy `adjustStockSchema` in
 * `@weldsuite/core-api-client/schemas/weldstash` — every field that schema
 * required is still required here with the same shape, so existing callers keep
 * validating unchanged. `type` defaults to the direction of the delta.
 */
export const adjustInventorySchema = z.object({
  productId: z.string().min(1).max(30),
  variantId: z.string().max(30).nullish(),
  warehouseId: z.string().min(1).max(30),
  locationId: z.string().max(30).nullish(),

  /** Signed change in units. Must not be zero. */
  delta: z.number().int(),
  reason: z.string().min(1).max(500),

  type: stockAdjustmentTypeSchema.optional(),
  reasonCode: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),

  // Lot / batch / expiry. Required on receipt only when the product opts into
  // the matching tracking flag; the ledger enforces that, not this schema,
  // because the flags live on the product row.
  lotNumber: z.string().max(100).optional(),
  batchNumber: z.string().max(100).optional(),
  expiryDate: z.coerce.date().optional(),

  /** Unit cost of the incoming units — feeds the moving average on receipt. */
  unitCost: z.number().min(0).optional(),

  sourceType: z.string().max(30).optional(),
  sourceId: z.string().max(30).nullish(),
  sourceNumber: z.string().max(100).optional(),
});

const transferEndpointSchema = z.object({
  warehouseId: z.string().min(1).max(30),
  locationId: z.string().max(30).nullish(),
  lotNumber: z.string().max(100).nullish(),
});

/** Move stock between two buckets. Records one `inventory_movements` row. */
export const transferInventorySchema = z.object({
  productId: z.string().min(1).max(30),
  variantId: z.string().max(30).nullish(),
  quantity: z.number().int().positive(),
  from: transferEndpointSchema,
  to: transferEndpointSchema,
  reason: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

/** Query the audit trail behind `GET /api/inventory/ledger`. */
export const inventoryLedgerQuerySchema = z.object({
  productId: z.string().max(30).optional(),
  variantId: z.string().max(30).optional(),
  warehouseId: z.string().max(30).optional(),
  locationId: z.string().max(30).optional(),
  lotNumber: z.string().max(100).optional(),
  type: stockAdjustmentTypeSchema.optional(),
  sourceType: z.string().max(30).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Create an empty stock bucket (a warehouse / location / lot slot for a
 * product).
 *
 * Quantity fields are deliberately absent: stock only moves through
 * `POST /api/inventory/adjust` and `/transfer`, so that every unit is audited
 * and the product roll-up stays correct. A bucket starts at zero and is filled
 * by an adjustment.
 *
 * Replaces `createInventorySchema` from
 * `@weldsuite/core-api-client/schemas/inventory`, whose fields (`quantity`,
 * `reservedQuantity`, `reorderPoint`, …) never matched the `inventory` table.
 */
export const createInventoryBucketSchema = z.object({
  productId: z.string().min(1).max(30),
  variantId: z.string().max(30).nullish(),
  warehouseId: z.string().min(1).max(30),
  locationId: z.string().max(30).nullish(),

  lotNumber: z.string().max(100).nullish(),
  batchNumber: z.string().max(100).nullish(),
  serialNumber: z.string().max(100).nullish(),

  expiryDate: z.coerce.date().nullish(),
  manufactureDate: z.coerce.date().nullish(),

  unitCost: z.number().min(0).nullish(),
  currency: z.string().length(3).optional(),

  // available | quarantine | damaged | expired | reserved
  status: z.string().max(30).optional(),
  qualityStatus: z.string().max(30).optional(), // passed | failed | pending | na

  metadata: z.record(z.unknown()).optional(),
});

/**
 * Patch a bucket's non-quantity attributes. `productId` / `warehouseId` are
 * omitted — they identify the bucket, and moving stock to a different warehouse
 * is a transfer, not an edit.
 */
export const updateInventoryBucketSchema = createInventoryBucketSchema
  .omit({ productId: true, warehouseId: true })
  .partial()
  .extend({
    isQuarantined: z.boolean().optional(),
    quarantineReason: z.string().max(2000).nullish(),
    lastInspectionDate: z.coerce.date().nullish(),
  });

export type CreateInventoryBucketInput = z.infer<typeof createInventoryBucketSchema>;
export type UpdateInventoryBucketInput = z.infer<typeof updateInventoryBucketSchema>;
export type StockAdjustmentTypeValue = z.infer<typeof stockAdjustmentTypeSchema>;
export type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;
export type TransferInventoryInput = z.infer<typeof transferInventorySchema>;
export type InventoryLedgerQuery = z.infer<typeof inventoryLedgerQuerySchema>;
