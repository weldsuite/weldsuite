import { z } from 'zod';

export const createDiscountSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().max(50).optional(),
  type: z.string().max(30).optional(),
  value: z.union([z.string(), z.number()]).optional(),
  websiteId: z.string().nullish(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateDiscountSchema = createDiscountSchema.partial();
export type CreateDiscountInput = z.infer<typeof createDiscountSchema>;
export type UpdateDiscountInput = z.infer<typeof updateDiscountSchema>;
