import { z } from 'zod';

// `/api/vat-returns` — periodic VAT/sales-tax filings.

export const createVatReturnSchema = z.object({
  entityId: z.string().nullish(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  jurisdiction: z.string().max(50).optional(),
  status: z.string().max(30).optional(),
  totalSales: z.union([z.string(), z.number()]).optional(),
  totalPurchases: z.union([z.string(), z.number()]).optional(),
  totalVat: z.union([z.string(), z.number()]).optional(),
  submittedAt: z.string().optional(),
  filingReference: z.string().max(255).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateVatReturnSchema = createVatReturnSchema.partial();

export type CreateVatReturnInput = z.infer<typeof createVatReturnSchema>;
export type UpdateVatReturnInput = z.infer<typeof updateVatReturnSchema>;
