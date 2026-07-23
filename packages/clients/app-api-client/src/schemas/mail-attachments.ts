/**
 * `/api/mail-attachments` — backed by `mail_attachments`.
 *
 * The compose flow uploads to R2 first (via the storage worker's
 * signed-URL route), then calls `POST /associate` once the parent
 * message exists.
 */

import { z } from 'zod';

export const createMailAttachmentSchema = z.object({
  messageId: z.string().min(1),
  fileName: z.string().min(1).max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().nonnegative(),
  storagePath: z.string().max(1000).optional(),
  downloadUrl: z.string().optional(),
  checksum: z.string().max(64).optional(),
  isInline: z.boolean().optional(),
  contentId: z.string().max(255).nullish(),
  contentDisposition: z.string().max(100).optional(),
});

export const updateMailAttachmentSchema = createMailAttachmentSchema.partial();

export const associateMailAttachmentsSchema = z.object({
  messageId: z.string().min(1),
  attachmentIds: z.array(z.string()).min(1).max(100),
});

export type CreateMailAttachmentInput = z.infer<typeof createMailAttachmentSchema>;
export type UpdateMailAttachmentInput = z.infer<typeof updateMailAttachmentSchema>;
export type AssociateMailAttachmentsInput = z.infer<typeof associateMailAttachmentsSchema>;
