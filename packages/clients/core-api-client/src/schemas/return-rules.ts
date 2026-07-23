import { z } from 'zod';

export const createReturnRuleSchema = z.object({
  name: z.string().min(1).max(255),
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateReturnRuleSchema = createReturnRuleSchema.partial();
export type CreateReturnRuleInput = z.infer<typeof createReturnRuleSchema>;
export type UpdateReturnRuleInput = z.infer<typeof updateReturnRuleSchema>;
