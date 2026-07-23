import { z } from 'zod';

// `/api/recurring-invoices` — invoice templates scheduled to fire.

export const createRecurringInvoiceSchema = z.object({
  name: z.string().max(255).optional(),
  customerId: z.string().nullish(),
  entityId: z.string().nullish(),
  status: z.string().max(30).optional(),
  frequency: z.string().max(30).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  nextRunAt: z.string().optional(),
  currency: z.string().max(10).optional(),
  total: z.union([z.string(), z.number()]).optional(),
  templateData: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateRecurringInvoiceSchema = createRecurringInvoiceSchema.partial();

export type CreateRecurringInvoiceInput = z.infer<typeof createRecurringInvoiceSchema>;
export type UpdateRecurringInvoiceInput = z.infer<typeof updateRecurringInvoiceSchema>;
