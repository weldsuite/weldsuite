import { z } from 'zod';

export const createPurchaseOrderSchema = z.object({
  poNumber: z.string().max(100).optional(),
  supplierId: z.string().nullish(),
  warehouseId: z.string().nullish(),
  status: z.string().max(30).optional(),
  orderDate: z.string().optional(),
  expectedDate: z.string().optional(),
  total: z.union([z.string(), z.number()]).optional(),
  currency: z.string().max(10).optional(),
  notes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updatePurchaseOrderSchema = createPurchaseOrderSchema.partial();
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

// ── Purchase order lines (`/api/purchase-orders/:id/items`) ─────────────────

/** A price or percentage with at most two decimals, as the numeric columns keep them. */
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const TWO_DECIMALS = 'Use at most two decimals';

const purchaseOrderItemFields = {
  productId: z.string().max(30).nullish(),
  variantId: z.string().max(30).nullish(),
  sku: z.string().max(100).nullish(),
  name: z.string().min(1).max(255),
  description: z.string().nullish(),
  quantityOrdered: z.number().int().min(1).max(1_000_000),
  quantityReceived: z.number().int().min(0).max(1_000_000),
  quantityRejected: z.number().int().min(0).max(1_000_000),
  unitPrice: z.number().min(0).max(10_000_000).refine(twoDecimals, TWO_DECIMALS),
  discountPercent: z.number().min(0).max(100).refine(twoDecimals, TWO_DECIMALS),
  taxPercent: z.number().min(0).max(100).refine(twoDecimals, TWO_DECIMALS),
  notes: z.string().nullish(),
  /**
   * The WeldFlow project the line's cost belongs to (FLOW-019); null takes the
   * tag off. The project must be a live one of the workspace.
   */
  projectId: z.string().max(255).nullish(),
};

/** A line: a name and a unit price; one unit ordered unless the body says otherwise. */
export const createPurchaseOrderItemSchema = z.object({
  ...purchaseOrderItemFields,
  unitPrice: purchaseOrderItemFields.unitPrice,
  quantityOrdered: purchaseOrderItemFields.quantityOrdered.optional(),
  quantityReceived: purchaseOrderItemFields.quantityReceived.optional(),
  quantityRejected: purchaseOrderItemFields.quantityRejected.optional(),
  discountPercent: purchaseOrderItemFields.discountPercent.optional(),
  taxPercent: purchaseOrderItemFields.taxPercent.optional(),
});
export const updatePurchaseOrderItemSchema = z.object(purchaseOrderItemFields).partial();
export type CreatePurchaseOrderItemInput = z.infer<typeof createPurchaseOrderItemSchema>;
export type UpdatePurchaseOrderItemInput = z.infer<typeof updatePurchaseOrderItemSchema>;
