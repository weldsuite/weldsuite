import { z } from 'zod';

export const createCarrierSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  trackingUrlTemplate: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  config: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateCarrierSchema = createCarrierSchema.partial();
export type CreateCarrierInput = z.infer<typeof createCarrierSchema>;
export type UpdateCarrierInput = z.infer<typeof updateCarrierSchema>;
