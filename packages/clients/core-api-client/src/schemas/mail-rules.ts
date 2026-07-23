import { z } from 'zod';

// `/api/mail-rules` — backed by `mail_rules`. Inbox automation rules.

export const createMailRuleSchema = z.object({
  name: z.string().min(1).max(255),
  scope: z.string().max(50).optional(),
  matchType: z.string().max(50).optional(),
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  accountId: z.string().nullish(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailRuleSchema = createMailRuleSchema.partial();

export type CreateMailRuleInput = z.infer<typeof createMailRuleSchema>;
export type UpdateMailRuleInput = z.infer<typeof updateMailRuleSchema>;
