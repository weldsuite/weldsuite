import { z } from 'zod';

// `/api/bank-accounts` — bank accounts used by the accounting module.

export const createBankAccountSchema = z.object({
  name: z.string().min(1).max(255),
  bankName: z.string().max(255).optional(),
  accountNumber: z.string().max(100).optional(),
  iban: z.string().max(50).optional(),
  swift: z.string().max(50).optional(),
  currency: z.string().max(10).optional(),
  entityId: z.string().nullish(),
  glAccountId: z.string().nullish(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateBankAccountSchema = createBankAccountSchema.partial();

export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;
