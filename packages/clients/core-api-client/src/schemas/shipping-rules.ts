import { z } from 'zod';

export const createShippingRuleSchema = z.object({
  name: z.string().min(1).max(255),
  conditions: z.unknown().optional(),
  carrierId: z.string().nullish(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateShippingRuleSchema = createShippingRuleSchema.partial();
export type CreateShippingRuleInput = z.infer<typeof createShippingRuleSchema>;
export type UpdateShippingRuleInput = z.infer<typeof updateShippingRuleSchema>;
