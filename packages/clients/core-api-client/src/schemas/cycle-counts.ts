import { z } from 'zod';

export const createCycleCountSchema = z.object({
  warehouseId: z.string().nullish(),
  status: z.string().max(30).optional(),
  scheduledDate: z.string().optional(),
  countedBy: z.string().optional(),
  notes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateCycleCountSchema = createCycleCountSchema.partial();
export type CreateCycleCountInput = z.infer<typeof createCycleCountSchema>;
export type UpdateCycleCountInput = z.infer<typeof updateCycleCountSchema>;
