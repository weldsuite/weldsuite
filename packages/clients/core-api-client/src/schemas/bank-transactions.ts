import { z } from 'zod';

// `/api/bank-transactions` — bank statement lines (imported or entered by hand).

const amountSchema = z.union([z.string(), z.number()]).refine((value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n !== 0;
}, { message: 'Amount must be a non-zero number' });

export const createBankTransactionSchema = z.object({
  bankAccountId: z.string().min(1),
  date: z.string().min(1),
  amount: amountSchema,
  description: z.string().optional(),
  valueDate: z.string().optional(),
  counterpartyName: z.string().max(255).optional(),
  counterpartyIban: z.string().max(50).optional(),
  counterpartyBic: z.string().max(11).optional(),
  reference: z.string().max(255).optional(),
  notes: z.string().optional(),
});

export const updateBankTransactionSchema = createBankTransactionSchema.partial();

export type CreateBankTransactionInput = z.infer<typeof createBankTransactionSchema>;
export type UpdateBankTransactionInput = z.infer<typeof updateBankTransactionSchema>;
