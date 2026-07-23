import { z } from 'zod';

// `/api/bank-transactions` — imported bank statement lines.

export const createBankTransactionSchema = z.object({
  bankAccountId: z.string(),
  reference: z.string().max(255).optional(),
  description: z.string().optional(),
  amount: z.union([z.string(), z.number()]),
  currency: z.string().max(10).optional(),
  transactionDate: z.string().optional(),
  counterpartyName: z.string().max(255).optional(),
  counterpartyIban: z.string().max(50).optional(),
  matchedInvoiceId: z.string().nullish(),
  matchedBillId: z.string().nullish(),
  matchedPaymentId: z.string().nullish(),
  status: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateBankTransactionSchema = createBankTransactionSchema.partial();

export type CreateBankTransactionInput = z.infer<typeof createBankTransactionSchema>;
export type UpdateBankTransactionInput = z.infer<typeof updateBankTransactionSchema>;
