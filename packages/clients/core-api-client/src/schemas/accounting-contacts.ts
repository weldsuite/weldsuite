import { z } from 'zod';

// `/api/accounting-contacts` — vendor/customer rows scoped to the accounting
// module (distinct from CRM contacts).

export const createAccountingContactSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['customer', 'supplier', 'both']).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  taxNumber: z.string().max(100).optional(),
  entityId: z.string().nullish(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateAccountingContactSchema = createAccountingContactSchema.partial();

export type CreateAccountingContactInput = z.infer<typeof createAccountingContactSchema>;
export type UpdateAccountingContactInput = z.infer<typeof updateAccountingContactSchema>;
