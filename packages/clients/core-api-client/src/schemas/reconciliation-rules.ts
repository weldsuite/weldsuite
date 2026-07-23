import { z } from 'zod';

// `/api/reconciliation-rules` — auto-match rules for bank reconciliation.

export const createReconciliationRuleSchema = z.object({
  name: z.string().min(1).max(255),
  bankAccountId: z.string().nullish(),
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateReconciliationRuleSchema = createReconciliationRuleSchema.partial();

export type CreateReconciliationRuleInput = z.infer<typeof createReconciliationRuleSchema>;
export type UpdateReconciliationRuleInput = z.infer<typeof updateReconciliationRuleSchema>;
