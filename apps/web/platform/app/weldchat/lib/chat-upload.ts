/**
 * Chat attachment uploads go through chat-api's `POST /chat-messages/upload`,
 * not the generic storage broker (`/storage/generate-upload-url`). The chat
 * route checks that the caller can post in the channel and that attachments
 * are on there, caps the size, refuses active content (HTML, SVG,
 * executables), rate-limits, and stores the file under the channel's own
 * namespace with an unguessable key segment. The broker did none of that.
 */

import type { ClientApi } from '@weldsuite/api-client/types';

/** chat-api's per-file limit (`MAX_UPLOAD_BYTES`), checked here so the user hears it before uploading. */
export const MAX_CHAT_UPLOAD_BYTES = 50 * 1024 * 1024;

/** chat-api's per-message limit (`MAX_MESSAGE_ATTACHMENTS`). */
export const MAX_MESSAGE_ATTACHMENTS = 10;

export interface UploadedChatFile {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export function isChatUploadTooLarge(file: Pick<Blob, 'size'>): boolean {
  return file.size > MAX_CHAT_UPLOAD_BYTES;
}

/**
 * Splits picked files into the ones that still fit on the message (given how
 * many it already carries) and the ones that do not.
 */
export function fitAttachments<T>(files: readonly T[], alreadyAttached: number): { accepted: T[]; rejected: T[] } {
  const room = Math.max(0, MAX_MESSAGE_ATTACHMENTS - alreadyAttached);
  return { accepted: files.slice(0, room), rejected: files.slice(room) };
}

export async function uploadChatFile(
  client: Pick<ClientApi, 'postForm'>,
  file: File,
  channelId?: string | null,
): Promise<UploadedChatFile> {
  const form = new FormData();
  form.append('file', file);
  if (channelId) form.append('channelId', channelId);
  const res = await client.postForm<{ data: UploadedChatFile }>('/chat-messages/upload', form);
  if (!res?.data?.url) throw new Error('Upload returned no file');
  return res.data;
}
