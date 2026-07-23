import { z } from 'zod';

// ============================================================================
// Stock Adjustments — append-only audit trail for all manual stock corrections.
// Every adjustment carries a reason. The audit trail is immutable; there is
// no update or delete endpoint (records are permanent by design).
//
// Backed by the `stock_adjustments` table
// (packages/db/src/schema/stock-adjustments.ts).
// Permission prefix: `inventory:*`.
// ============================================================================

export const createStockAdjustmentSchema = z.object({
  productId: z.string().min(1).max(30),
  warehouseId: z.string().max(30).nullish(),
  locationId: z.string().max(30).nullish(),
  inventoryId: z.string().max(30).nullish(),
  variantId: z.string().max(30).nullish(),

  // increase | decrease | correction | damage | return | transfer_in | transfer_out | received | shipped | cycle_count
  type: z.string().min(1).max(30),

  previousQuantity: z.number().int(),
  adjustmentQuantity: z.number().int(),
  newQuantity: z.number().int(),

  // Lot / batch tracking
  lotNumber: z.string().max(100).optional(),
  batchNumber: z.string().max(100).optional(),

  // Audit
  reason: z.string().optional(),
  reasonCode: z.string().max(50).optional(), // DAMAGE | THEFT | FOUND | RECOUNT | RECEIVED | SHIPPED | RETURN | OTHER
  notes: z.string().optional(),

  performedBy: z.string().max(255).optional(),
  performedByName: z.string().max(255).optional(),

  // Source document
  sourceType: z.string().max(30).optional(), // order | return | purchase_order | transfer | cycle_count | manual
  sourceId: z.string().max(30).nullish(),
  sourceNumber: z.string().max(100).optional(),

  // Approval
  requiresApproval: z.boolean().default(false),

  metadata: z.record(z.unknown()).optional(),
});

export type CreateStockAdjustmentInput = z.infer<typeof createStockAdjustmentSchema>;
