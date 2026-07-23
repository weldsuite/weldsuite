import { z } from 'zod';

export const createPickListSchema = z.object({
  warehouseId: z.string().nullish(),
  status: z.string().max(30).optional(),
  assignedToId: z.string().nullish(),
  orderId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updatePickListSchema = createPickListSchema.partial();
export type CreatePickListInput = z.infer<typeof createPickListSchema>;
export type UpdatePickListInput = z.infer<typeof updatePickListSchema>;
