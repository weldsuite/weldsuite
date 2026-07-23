import { z } from 'zod';

// `/api/mail-messages` — backed by `mail_messages`.

export const createMailMessageSchema = z.object({
  accountId: z.string(),
  folderId: z.string().nullish(),
  subject: z.string().max(998).optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  fromEmail: z.string().email().max(255).optional(),
  fromName: z.string().max(255).optional(),
  toEmails: z.array(z.string()).optional(),
  ccEmails: z.array(z.string()).optional(),
  bccEmails: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailMessageSchema = createMailMessageSchema.partial();

export type CreateMailMessageInput = z.infer<typeof createMailMessageSchema>;
export type UpdateMailMessageInput = z.infer<typeof updateMailMessageSchema>;
