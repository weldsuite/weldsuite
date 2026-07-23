import { z } from 'zod';

export const createReturnSchema = z.object({
  orderId: z.string().nullish(),
  customerId: z.string().nullish(),
  status: z.string().max(30).optional(),
  reasonId: z.string().nullish(),
  reasonText: z.string().optional(),
  refundAmount: z.union([z.string(), z.number()]).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateReturnSchema = createReturnSchema.partial();
export type CreateReturnInput = z.infer<typeof createReturnSchema>;
export type UpdateReturnInput = z.infer<typeof updateReturnSchema>;
