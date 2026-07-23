import { z } from 'zod';

// `/api/bills` — supplier bills.

export const createBillSchema = z.object({
  reference: z.string().max(255).optional(),
  billNumber: z.string().max(100).optional(),
  supplierId: z.string().nullish(),
  supplierName: z.string().max(255).optional(),
  entityId: z.string().nullish(),
  status: z.string().max(30).optional(),
  issueDate: z.string().optional(),
  dueDate: z.string().optional(),
  currency: z.string().max(10).optional(),
  subtotal: z.union([z.string(), z.number()]).optional(),
  taxTotal: z.union([z.string(), z.number()]).optional(),
  total: z.union([z.string(), z.number()]).optional(),
  notes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateBillSchema = createBillSchema.partial();

export type CreateBillInput = z.infer<typeof createBillSchema>;
export type UpdateBillInput = z.infer<typeof updateBillSchema>;
