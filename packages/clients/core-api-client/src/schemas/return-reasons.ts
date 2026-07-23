import { z } from 'zod';

export const createReturnReasonSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  groupId: z.string().nullish(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateReturnReasonSchema = createReturnReasonSchema.partial();
export type CreateReturnReasonInput = z.infer<typeof createReturnReasonSchema>;
export type UpdateReturnReasonInput = z.infer<typeof updateReturnReasonSchema>;
