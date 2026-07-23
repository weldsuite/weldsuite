import { z } from 'zod';

export const createCartSchema = z.object({
  websiteId: z.string().nullish(),
  customerId: z.string().nullish(),
  status: z.string().max(30).optional(),
  currency: z.string().max(10).optional(),
  total: z.union([z.string(), z.number()]).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateCartSchema = createCartSchema.partial();
export type CreateCartInput = z.infer<typeof createCartSchema>;
export type UpdateCartInput = z.infer<typeof updateCartSchema>;
