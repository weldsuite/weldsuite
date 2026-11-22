import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { MailAttachmentScanStatus } from '@weldsuite/app-api-client/schemas/mail-attachments';
import { Button } from '@weldsuite/ui/components/button';
import { attachmentIcon } from '@/app/weldmail/lib/attachment-icon';
import { useI18n } from '@/lib/i18n/provider';
import { attachmentScanState } from '../lib/attachment-scan';

export interface AttachmentChipData {
  id: string;
  fileName: string;
  size: number;
  contentType?: string | null;
  scanStatus?: MailAttachmentScanStatus | null;
  scanSignature?: string | null;
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

/**
 * One attachment chip. A file the virus scan blocked (infected) or still holds
 * (pending) is not a button: it can't be clicked, and the server refuses it
 * anyway. A file the scanner could not read still downloads, with a warning.
 */
export function AttachmentChip({ att, onDownload }: Readonly<{
  att: AttachmentChipData;
  onDownload: (att: AttachmentChipData) => void;
}>) {
  const { t } = useI18n();
  const copy = t.mail.messageDetail;
  const state = attachmentScanState(att);
  const TypeIcon = attachmentIcon(att.fileName, att.contentType);

  if (state === 'infected') {
    const hint = copy.attachmentInfectedHint.replace('{signature}', att.scanSignature ?? '');
    return (
      <div
        title={`${att.fileName}: ${hint}`}
        className="inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
      >
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="max-w-[200px] truncate line-through">{att.fileName}</span>
          <span className="text-xs font-medium">
            {copy.attachmentInfected}
            {att.scanSignature ? ` · ${att.scanSignature}` : ''}
          </span>
        </span>
      </div>
    );
  }

  if (state === 'pending') {
    return (
      <div
        title={copy.attachmentScanningHint}
        className="inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground"
      >
        <TypeIcon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="max-w-[200px] truncate">{att.fileName}</span>
          <span className="text-xs">{copy.attachmentScanning}</span>
        </span>
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => onDownload(att)}
      title={state === 'scan-failed' ? `${att.fileName}: ${copy.attachmentScanFailedHint}` : att.fileName}
    >
      <TypeIcon />
      <span className="max-w-[200px] truncate">{att.fileName}</span>
      <span className="text-xs text-muted-foreground">{formatAttachmentSize(att.size)}</span>
      {state === 'scan-failed' && (
        <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {copy.attachmentScanFailed}
        </span>
      )}
    </Button>
  );
}
