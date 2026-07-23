import { z } from 'zod';

export const createInventoryMovementSchema = z.object({
  productId: z.string().nullish(),
  warehouseId: z.string().nullish(),
  type: z.string().max(30).optional(),
  quantity: z.number().int(),
  reference: z.string().max(255).optional(),
  notes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateInventoryMovementSchema = createInventoryMovementSchema.partial();
export type CreateInventoryMovementInput = z.infer<typeof createInventoryMovementSchema>;
export type UpdateInventoryMovementInput = z.infer<typeof updateInventoryMovementSchema>;
