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
