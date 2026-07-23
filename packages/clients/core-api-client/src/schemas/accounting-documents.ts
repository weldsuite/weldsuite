import { z } from 'zod';

// `/api/accounting-documents` — supporting documents attached to accounting
// entities (receipts, contracts, statements).

export const createAccountingDocumentSchema = z.object({
  fileName: z.string().max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().optional(),
  url: z.string().max(2000).optional(),
  storageKey: z.string().max(500).optional(),
  entityId: z.string().nullish(),
  attachedToType: z.string().max(50).optional(),
  attachedToId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateAccountingDocumentSchema = createAccountingDocumentSchema.partial();

export type CreateAccountingDocumentInput = z.infer<typeof createAccountingDocumentSchema>;
export type UpdateAccountingDocumentInput = z.infer<typeof updateAccountingDocumentSchema>;
