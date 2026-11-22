import { useCallback } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { MailAttachmentDownloadError, saveMailAttachment } from '../lib/download-attachment';
import { attachmentDownloadFailure } from '../lib/attachment-scan';

/**
 * Saves an attachment, with a specific toast when the virus scan holds the
 * file back (403 infected, 409 still scanning) and the generic one otherwise.
 */
export function useSaveMailAttachment() {
  const { t } = useI18n();
  return useCallback(
    (attachmentId: string, fileName: string) => {
      saveMailAttachment(attachmentId, fileName).catch((error: unknown) => {
        const code = error instanceof MailAttachmentDownloadError ? error.code : undefined;
        switch (attachmentDownloadFailure(code)) {
          case 'infected':
            toast.error(t.mail.messageDetail.downloadBlockedInfected);
            break;
          case 'scan-pending':
            toast.error(t.mail.messageDetail.downloadBlockedScanPending);
            break;
          default:
            toast.error(t.mail.messageDetail.failedToDownloadAttachment);
        }
      });
    },
    [t],
  );
}
