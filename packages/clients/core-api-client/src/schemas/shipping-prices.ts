import { z } from 'zod';

export const createShippingPriceSchema = z.object({
  name: z.string().min(1).max(255),
  carrierId: z.string().nullish(),
  conditions: z.unknown().optional(),
  price: z.union([z.string(), z.number()]).optional(),
  currency: z.string().max(10).optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateShippingPriceSchema = createShippingPriceSchema.partial();
export type CreateShippingPriceInput = z.infer<typeof createShippingPriceSchema>;
export type UpdateShippingPriceInput = z.infer<typeof updateShippingPriceSchema>;
