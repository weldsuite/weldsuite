import { appApiClient } from '@/services/app-api';

/** A file picked in the composer (from image/document/camera pickers). */
export interface PickedAttachment {
  name: string;
  uri: string;
  type: string;
}

/** The descriptor the mail-send endpoint expects (see `mailSendAttachmentSchema`). */
export interface UploadedAttachment {
  filename: string;
  contentType: string;
  size: number;
  fileKey: string;
}

interface GenerateUploadUrlResponse {
  success: boolean;
  uploadUrl: string;
  uploadToken: string;
  fileKey: string;
}

/**
 * Upload a single picked attachment to R2 via the app-api storage broker and
 * return the descriptor the mail-send endpoint references by `fileKey`.
 *
 * Flow (mirrors apps/workers/app-api/src/routes/storage):
 *  1. read the local file bytes;
 *  2. POST /storage/generate-upload-url (Clerk-authenticated) → a one-shot,
 *     token-scoped PUT url + the R2 `fileKey`;
 *  3. PUT the bytes to that url (the url's token is the capability — no Clerk
 *     header is sent or required);
 *  4. return `{ filename, contentType, size, fileKey }`.
 *
 * Throws on any failure so the caller can abort the send and surface an error
 * instead of silently sending the email without its attachments.
 */
export async function uploadMailAttachment(att: PickedAttachment): Promise<UploadedAttachment> {
  const fileResponse = await fetch(att.uri);
  if (!fileResponse.ok) {
    throw new Error(`Could not read "${att.name}"`);
  }
  const blob = await fileResponse.blob();
  const contentType = att.type || blob.type || 'application/octet-stream';
  const size = blob.size;

  const gen = await appApiClient.post<GenerateUploadUrlResponse>('/storage/generate-upload-url', {
    fileName: att.name,
    contentType,
    fileSize: size,
    folder: 'mail-attachments',
  });
  if (!gen?.uploadUrl || !gen?.fileKey) {
    throw new Error(`Upload URL unavailable for "${att.name}"`);
  }

  // `uploadUrl` is an absolute URL whose path token authorises the write, so this
  // is a plain unauthenticated PUT of the raw bytes.
  const putResponse = await fetch(gen.uploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': contentType },
  });
  if (!putResponse.ok) {
    throw new Error(`Upload failed for "${att.name}" (${putResponse.status})`);
  }

  return { filename: att.name, contentType, size, fileKey: gen.fileKey };
}

/** Upload all picked attachments; rejects if any one fails (so nothing is sent partially). */
export async function uploadMailAttachments(
  attachments: PickedAttachment[],
): Promise<UploadedAttachment[]> {
  return Promise.all(attachments.map(uploadMailAttachment));
}
