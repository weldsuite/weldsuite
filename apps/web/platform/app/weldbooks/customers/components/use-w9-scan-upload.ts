import { useCallback, useState } from 'react';
import { useFileUpload } from '@/hooks/use-file-upload';
import { accountingApi } from '@/lib/api/domains/weldbooks';

/** The scan of a W-9 can be a PDF or a photo; 10 MB is more than any scan needs. */
export const W9_SCAN_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const W9_SCAN_MAX_BYTES = 10 * 1024 * 1024;

export interface UploadedW9Scan {
  documentId: string;
  fileName: string;
}

export type W9ScanProblem = 'type' | 'size' | 'upload';

/**
 * Uploads the scan of a W-9 and files it in the accounting documents as a
 * `tax_form`. That type keeps the document out of the OCR inbox: a W-9 carries
 * a TIN, which must never reach an AI prompt.
 */
export function useW9ScanUpload() {
  const upload = useFileUpload({ folder: 'weldbooks/documents', entityType: 'accounting_document', isPublic: false });
  const { uploadFile } = upload;
  const [problem, setProblem] = useState<W9ScanProblem | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const uploadScan = useCallback(
    async (file: File): Promise<UploadedW9Scan | null> => {
      setProblem(null);
      if (!(W9_SCAN_TYPES as readonly string[]).includes(file.type)) {
        setProblem('type');
        return null;
      }
      if (file.size > W9_SCAN_MAX_BYTES) {
        setProblem('size');
        return null;
      }
      setIsUploading(true);
      try {
        const uploaded = await uploadFile(file);
        if (!uploaded) {
          setProblem('upload');
          return null;
        }
        const created = await accountingApi.createDocument({
          type: 'tax_form',
          fileName: uploaded.fileName,
          fileKey: uploaded.fileKey,
          mimeType: uploaded.mimeType,
          fileSize: uploaded.fileSize,
          source: 'upload',
        });
        const documentId = created?.data?.id;
        if (!documentId) {
          setProblem('upload');
          return null;
        }
        return { documentId, fileName: uploaded.fileName };
      } catch {
        setProblem('upload');
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [uploadFile],
  );

  return { uploadScan, isUploading, problem, clearProblem: () => setProblem(null) };
}
