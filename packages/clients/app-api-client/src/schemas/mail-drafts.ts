/**
 * `/api/mail-drafts` — backed by `mail_drafts`.
 */

import { z } from 'zod';

const draftBaseFields = {
  subject: z.string().max(998).optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.array(z.string()).optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  labels: z.array(z.string()).optional(),
  attachmentIds: z.array(z.string()).optional(),
  inReplyTo: z.string().max(500).optional(),
  originalMessageId: z.string().nullish(),
  isReply: z.boolean().optional(),
  isForward: z.boolean().optional(),
} as const;

export const createMailDraftSchema = z.object({ accountId: z.string().min(1), ...draftBaseFields });
export const updateMailDraftSchema = z.object(draftBaseFields).partial();

export const listMailDraftsQuery = z.object({
  accountId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type CreateMailDraftInput = z.infer<typeof createMailDraftSchema>;
export type UpdateMailDraftInput = z.infer<typeof updateMailDraftSchema>;
export type ListMailDraftsQuery = z.infer<typeof listMailDraftsQuery>;
