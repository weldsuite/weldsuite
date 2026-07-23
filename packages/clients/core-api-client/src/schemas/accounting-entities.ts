import { z } from 'zod';

// `/api/accounting-entities` — legal entities for multi-entity accounting.

export const createAccountingEntitySchema = z.object({
  name: z.string().min(1).max(255),
  legalName: z.string().max(255).optional(),
  registrationNumber: z.string().max(100).optional(),
  vatNumber: z.string().max(100).optional(),
  baseCurrency: z.string().max(10).optional(),
  jurisdiction: z.string().max(50).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  isDefault: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateAccountingEntitySchema = createAccountingEntitySchema.partial();

export type CreateAccountingEntityInput = z.infer<typeof createAccountingEntitySchema>;
export type UpdateAccountingEntityInput = z.infer<typeof updateAccountingEntitySchema>;
