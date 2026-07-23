import { z } from 'zod';

// `/api/mail-signatures` — backed by `mail_signatures`.

export const createMailSignatureSchema = z.object({
  name: z.string().min(1).max(255),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  type: z.string().max(50).optional(),
  position: z.string().max(50).optional(),
  isDefault: z.boolean().optional(),
  accountId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailSignatureSchema = createMailSignatureSchema.partial();

export type CreateMailSignatureInput = z.infer<typeof createMailSignatureSchema>;
export type UpdateMailSignatureInput = z.infer<typeof updateMailSignatureSchema>;
