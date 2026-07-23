/**
 * WeldChat file upload service (app-api).
 *
 * Streams a multipart-uploaded file straight into the R2 `STORAGE` bucket and
 * returns its public URL + metadata. Pure-ish — takes the R2 bucket binding
 * and public URL rather than a Hono context.
 *
 * Ported from apps/mobile-api-worker/src/routes/v1/chat/index.ts (`POST
 * /upload`) and the legacy api-worker chat upload route.
 */

import { generateId } from '../../lib/id';

export interface ChatUploadResult {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  fileKey: string;
}

const DEFAULT_R2_PUBLIC_URL = 'https://weldsuite-storage-test.weldsuite.org';

/**
 * Store a chat file in R2 and return its public URL + metadata.
 *
 * Files are namespaced per workspace + channel so a stray key can never read
 * across tenants: `workspaces/<workspaceId>/chat/<channelId>/files/<id>.<ext>`.
 */
export async function uploadChatFile(params: {
  storage: R2Bucket;
  r2PublicUrl?: string;
  workspaceId: string;
  channelId?: string | null;
  file: File;
}): Promise<ChatUploadResult> {
  const { storage, workspaceId, channelId, file } = params;

  const fileId = generateId('chatfile');
  // Sanitize the channelId + extension before they enter the storage key — a
  // crafted channelId ("../other") or filename must never escape the
  // workspace's namespace or manipulate the key.
  const safeChannel = (channelId || 'general').replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
  const rawExt = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const storageKey = `workspaces/${workspaceId}/chat/${safeChannel}/files/${fileId}${ext ? '.' + ext : ''}`;

  const arrayBuffer = await file.arrayBuffer();
  await storage.put(storageKey, arrayBuffer, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  const r2PublicUrl = params.r2PublicUrl || DEFAULT_R2_PUBLIC_URL;
  const fileUrl = `${r2PublicUrl}/${storageKey}`;

  return {
    id: fileId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    url: fileUrl,
    fileKey: storageKey,
  };
}
