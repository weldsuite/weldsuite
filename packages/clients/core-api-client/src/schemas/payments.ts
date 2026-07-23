import { z } from 'zod';

// `/api/payments` — money in/out events.

export const createPaymentSchema = z.object({
  reference: z.string().max(255).optional(),
  paymentNumber: z.string().max(100).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  invoiceId: z.string().nullish(),
  billId: z.string().nullish(),
  bankAccountId: z.string().nullish(),
  entityId: z.string().nullish(),
  amount: z.union([z.string(), z.number()]),
  currency: z.string().max(10).optional(),
  paymentDate: z.string().optional(),
  method: z.string().max(50).optional(),
  status: z.string().max(30).optional(),
  notes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updatePaymentSchema = createPaymentSchema.partial();

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;
