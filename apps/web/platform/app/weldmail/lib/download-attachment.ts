import { mailApi } from './api-client';

/**
 * A refused or failed attachment download. `code` is the server's error code:
 * `ATTACHMENT_INFECTED` (403) or `ATTACHMENT_SCAN_PENDING` (409) for a file
 * the virus scan holds back.
 */
export class MailAttachmentDownloadError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'MailAttachmentDownloadError';
  }
}

/**
 * Mail attachments are read through mail-api (`/mail-attachments/:id/download`),
 * which checks that the member may read the mailbox. The object's storage URL
 * has no session, signature or expiry, so nothing in the app links to it.
 */
export async function fetchMailAttachment(attachmentId: string): Promise<Blob> {
  const result = await mailApi.attachments.download(attachmentId);
  if (!result.success || !result.data) {
    throw new MailAttachmentDownloadError(result.error ?? 'Download failed', result.errorCode);
  }
  return result.data;
}

/** Download an attachment and hand it to the browser as a file save. */
export async function saveMailAttachment(attachmentId: string, fileName: string): Promise<void> {
  const blob = await fetchMailAttachment(attachmentId);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked after the click has been handled; revoking in the same tick
  // cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
