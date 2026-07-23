import { z } from 'zod';

export const createInventorySchema = z.object({
  productId: z.string().nullish(),
  warehouseId: z.string().nullish(),
  quantity: z.number().int().optional(),
  reservedQuantity: z.number().int().optional(),
  availableQuantity: z.number().int().optional(),
  reorderPoint: z.number().int().optional(),
  reorderQuantity: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateInventorySchema = createInventorySchema.partial();
export type CreateInventoryInput = z.infer<typeof createInventorySchema>;
export type UpdateInventoryInput = z.infer<typeof updateInventorySchema>;
