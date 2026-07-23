import { z } from 'zod';

// `/api/mail-drafts` — backed by `mail_drafts`.

export const createMailDraftSchema = z.object({
  accountId: z.string(),
  subject: z.string().max(998).optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  toEmails: z.array(z.string()).optional(),
  ccEmails: z.array(z.string()).optional(),
  bccEmails: z.array(z.string()).optional(),
  replyToMessageId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailDraftSchema = createMailDraftSchema.partial();

export type CreateMailDraftInput = z.infer<typeof createMailDraftSchema>;
export type UpdateMailDraftInput = z.infer<typeof updateMailDraftSchema>;
