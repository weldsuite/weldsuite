/**
 * The original of an inbox document, shown next to the form that books it:
 * the library's `DocumentViewer` on the document's private-file address, with
 * the toolbar words from the dictionary.
 */

import { DocumentViewer } from '@weldsuite/ui/components/document-viewer';
import { documentFileUrl } from '@/app/weldbooks/documents/document-actions';
import { useI18n } from '@/lib/i18n/provider';

export interface SourceDocumentViewerProps {
  fileKey: string | null | undefined;
  mimeType?: string | null;
  fileName?: string | null;
  className?: string;
}

export function SourceDocumentViewer({ fileKey, mimeType, fileName, className }: Readonly<SourceDocumentViewerProps>) {
  const { t } = useI18n();
  if (!fileKey) return null;
  return (
    <DocumentViewer
      src={documentFileUrl(fileKey)}
      mimeType={mimeType}
      fileName={fileName}
      labels={t.weldbooksReceipts.viewer}
      className={className}
    />
  );
}
