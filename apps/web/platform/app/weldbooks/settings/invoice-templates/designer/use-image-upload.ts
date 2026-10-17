import { useCallback } from 'react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';

/** Only PNG and JPEG can be embedded in the invoice PDF. */
export const TEMPLATE_IMAGE_TYPES = ['image/png', 'image/jpeg'] as const;
export const TEMPLATE_IMAGE_ACCEPT = TEMPLATE_IMAGE_TYPES.join(',');
export const TEMPLATE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

interface GenerateResponse {
  success: boolean;
  uploadUrl?: string;
  uploadToken?: string;
  fileKey?: string;
}

interface ConfirmResponse {
  success: boolean;
  file?: { url: string };
}

/**
 * Uploads a logo or picture of the invoice designer to the workspace's public
 * `branding` folder (the same three-step flow as the business settings logo)
 * and resolves with its public URL. Rejects with a translated message.
 */
export function useTemplateImageUpload() {
  const { getClient } = useAppApiClient();
  const { t } = useI18n();
  const tb = t.accounting.invoiceTemplates.inspector.branding;

  return useCallback(
    async (file: File): Promise<string> => {
      if (!(TEMPLATE_IMAGE_TYPES as readonly string[]).includes(file.type)) throw new Error(tb.logoType);
      if (file.size > TEMPLATE_IMAGE_MAX_BYTES) throw new Error(tb.logoTooLarge);

      const client = await getClient();
      const generated = await client.post<GenerateResponse>('/storage/generate-upload-url', {
        fileName: file.name,
        contentType: file.type,
        fileSize: file.size,
        folder: 'branding',
        entityType: 'invoice-branding',
        isPublic: true,
      });
      if (!generated?.uploadUrl || !generated.uploadToken || !generated.fileKey) throw new Error(tb.uploadFailed);

      const uploaded = await fetch(generated.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!uploaded.ok) throw new Error(tb.uploadFailed);

      const confirmed = await client.post<ConfirmResponse>('/storage/confirm-upload', {
        uploadToken: generated.uploadToken,
        fileKey: generated.fileKey,
        etag: uploaded.headers.get('ETag') || undefined,
      });
      const url = confirmed?.file?.url;
      if (!url) throw new Error(tb.uploadFailed);
      return url;
    },
    [getClient, tb],
  );
}
