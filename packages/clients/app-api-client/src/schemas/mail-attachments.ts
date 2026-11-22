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
  // R2 key under `workspaces/{orgId}/`; write-only, never returned.
  storagePath: z.string().max(1000).optional(),
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

/**
 * Virus-scan state of an inbound attachment (EU and self-hosted editions; the
 * fields are absent on Global). `null` or absent: never scanned (older mail,
 * outbound uploads), treated as normal. `error`: the scanner could not read the
 * file; it still downloads. `pending`: the scanner was unreachable and a rescan
 * job settles it; the download answers 409 until then.
 */
export const mailAttachmentScanStatusSchema = z.enum(['clean', 'infected', 'pending', 'error']);

export type MailAttachmentScanStatus = z.infer<typeof mailAttachmentScanStatusSchema>;

/** The scan fields an attachment object carries. */
export const mailAttachmentScanSchema = z.object({
  scanStatus: mailAttachmentScanStatusSchema.nullish(),
  /** ClamAV signature name when infected, e.g. `Win.Test.EICAR_HDB-1`. */
  scanSignature: z.string().nullish(),
  scannedAt: z.string().nullish(),
});

export type MailAttachmentScan = z.infer<typeof mailAttachmentScanSchema>;

/** Error codes `GET /api/mail-attachments/:id/download` answers for a scanned file. */
export const MAIL_ATTACHMENT_DOWNLOAD_ERROR_CODES = {
  /** 403: the file is infected and is never served. */
  infected: 'ATTACHMENT_INFECTED',
  /** 409: the scan has not finished (the scanner was unreachable). */
  scanPending: 'ATTACHMENT_SCAN_PENDING',
} as const;
