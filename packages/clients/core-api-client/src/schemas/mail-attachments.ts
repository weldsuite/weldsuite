import { z } from 'zod';

// `/api/mail-attachments` — backed by `mail_attachments`.

export const createMailAttachmentSchema = z.object({
  messageId: z.string().nullish(),
  draftId: z.string().nullish(),
  fileName: z.string().max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().optional(),
  url: z.string().max(2000).optional(),
  storageKey: z.string().max(500).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailAttachmentSchema = createMailAttachmentSchema.partial();

export type CreateMailAttachmentInput = z.infer<typeof createMailAttachmentSchema>;
export type UpdateMailAttachmentInput = z.infer<typeof updateMailAttachmentSchema>;
