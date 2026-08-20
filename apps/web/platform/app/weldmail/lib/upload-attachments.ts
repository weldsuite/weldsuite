/**
 * Upload local files to R2 via the storage presign flow, then return the
 * `{ filename, fileKey }` descriptors `/send`, `/reply`, and `/forward` expect.
 *
 * Shared by the full compose page, the floating panel, and the inline
 * reply/forward box so the three surfaces stay in lockstep.
 */

export const MAX_EMAIL_SIZE_BYTES = 5 * 1024 * 1024;

export interface MailAttachmentRef {
  filename: string;
  contentType: string;
  size: number;
  fileKey: string;
}

export type MailUploadClient = {
  post: <T>(path: string, data?: unknown) => Promise<T>;
};

export class MailAttachmentUploadError extends Error {
  constructor(public readonly filename: string) {
    super(`Failed to upload ${filename}`);
    this.name = 'MailAttachmentUploadError';
  }
}

export function emailSizeExceedsLimit(body: string, htmlBody: string, files: File[]): boolean {
  const bodyBytes =
    new TextEncoder().encode(body).byteLength + new TextEncoder().encode(htmlBody).byteLength;
  const attachmentBytes = files.reduce((sum, file) => sum + file.size, 0);
  return bodyBytes + attachmentBytes > MAX_EMAIL_SIZE_BYTES;
}

export async function uploadMailAttachments(
  client: MailUploadClient,
  accountId: string,
  files: File[],
): Promise<MailAttachmentRef[]> {
  const uploaded: MailAttachmentRef[] = [];
  for (const file of files) {
    const contentType = file.type || 'application/octet-stream';
    try {
      const genResp = await client.post<{
        uploadUrl: string;
        uploadToken: string;
        fileKey: string;
      }>('/storage/generate-upload-url', {
        fileName: file.name,
        contentType,
        fileSize: file.size,
        folder: 'mail-attachments',
        entityType: 'mail-attachment',
        entityId: accountId,
        isPublic: false,
      });
      const putResp = await fetch(genResp.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': contentType },
      });
      if (!putResp.ok) throw new Error(`Upload failed: ${putResp.status}`);
      uploaded.push({
        filename: file.name,
        contentType,
        size: file.size,
        fileKey: genResp.fileKey,
      });
    } catch {
      throw new MailAttachmentUploadError(file.name);
    }
  }
  return uploaded;
}
