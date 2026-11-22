/**
 * How an attachment is shown and whether it can be downloaded, from its
 * virus-scan state (EU and self-hosted editions; Global sends no scan fields,
 * which reads as "not scanned").
 */

import type { MailAttachmentScanStatus } from '@weldsuite/app-api-client/schemas/mail-attachments';
import { MAIL_ATTACHMENT_DOWNLOAD_ERROR_CODES } from '@weldsuite/app-api-client/schemas/mail-attachments';

export interface ScannableAttachment {
  scanStatus?: MailAttachmentScanStatus | null;
  scanSignature?: string | null;
}

/**
 * - `normal`: clean, never scanned, or scan fields absent.
 * - `infected`: blocked, red, not clickable.
 * - `pending`: still being scanned, not clickable.
 * - `scan-failed`: the scanner could not read it; downloads with a warning hint.
 */
export type AttachmentScanState = 'normal' | 'infected' | 'pending' | 'scan-failed';

export function attachmentScanState(att: ScannableAttachment): AttachmentScanState {
  switch (att.scanStatus) {
    case 'infected':
      return 'infected';
    case 'pending':
      return 'pending';
    case 'error':
      return 'scan-failed';
    default:
      return 'normal';
  }
}

/** Whether the file can be fetched: infected and pending ones are refused by the server too. */
export function isAttachmentDownloadable(att: ScannableAttachment): boolean {
  const state = attachmentScanState(att);
  return state === 'normal' || state === 'scan-failed';
}

/** Whether the original attachment may ride along on a forward. */
export const isAttachmentForwardable = isAttachmentDownloadable;

export type AttachmentDownloadFailure = 'infected' | 'scan-pending' | 'other';

/** Maps the error code of a refused download onto the toast to show. */
export function attachmentDownloadFailure(errorCode: string | undefined): AttachmentDownloadFailure {
  if (errorCode === MAIL_ATTACHMENT_DOWNLOAD_ERROR_CODES.infected) return 'infected';
  if (errorCode === MAIL_ATTACHMENT_DOWNLOAD_ERROR_CODES.scanPending) return 'scan-pending';
  return 'other';
}
