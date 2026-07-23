import { z } from 'zod';

export const createWarehouseSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().max(50).optional(),
  address: z.unknown().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateWarehouseSchema = createWarehouseSchema.partial();
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;
