/**
 * `/api/mail-signatures` — backed by `mail_signatures`.
 */

import { z } from 'zod';

export const mailSignatureType = z.enum(['personal', 'company', 'department']);
export const mailSignaturePosition = z.enum(['above', 'below']);

const signatureBaseFields = {
  name: z.string().min(1).max(255),
  content: z.string().min(1),
  isDefault: z.boolean().optional(),
  type: mailSignatureType.optional(),
  accountIds: z.array(z.string()).optional(),
  userIds: z.array(z.string()).optional(),
  includeInReplies: z.boolean().optional(),
  includeInForwards: z.boolean().optional(),
  position: mailSignaturePosition.optional(),
  tags: z.array(z.string()).optional(),
} as const;

export const createMailSignatureSchema = z.object(signatureBaseFields);
export const updateMailSignatureSchema = z.object(signatureBaseFields).partial();

export const listMailSignaturesQuery = z.object({
  type: mailSignatureType.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type CreateMailSignatureInput = z.infer<typeof createMailSignatureSchema>;
export type UpdateMailSignatureInput = z.infer<typeof updateMailSignatureSchema>;
export type ListMailSignaturesQuery = z.infer<typeof listMailSignaturesQuery>;
