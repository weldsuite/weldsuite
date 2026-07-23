import { z } from 'zod';

// `/api/invoices` — customer invoices.

export const createInvoiceSchema = z.object({
  reference: z.string().max(255).optional(),
  invoiceNumber: z.string().max(100).optional(),
  customerId: z.string().nullish(),
  customerName: z.string().max(255).optional(),
  entityId: z.string().nullish(),
  status: z.string().max(30).optional(),
  issueDate: z.string().optional(),
  dueDate: z.string().optional(),
  currency: z.string().max(10).optional(),
  subtotal: z.union([z.string(), z.number()]).optional(),
  taxTotal: z.union([z.string(), z.number()]).optional(),
  total: z.union([z.string(), z.number()]).optional(),
  amountPaid: z.union([z.string(), z.number()]).optional(),
  notes: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateInvoiceSchema = createInvoiceSchema.partial();

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
