import { z } from 'zod';

export const createPickupSchema = z.object({
  carrierId: z.string().nullish(),
  warehouseId: z.string().nullish(),
  scheduledAt: z.string().optional(),
  status: z.string().max(30).optional(),
  notes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updatePickupSchema = createPickupSchema.partial();
export type CreatePickupInput = z.infer<typeof createPickupSchema>;
export type UpdatePickupInput = z.infer<typeof updatePickupSchema>;
