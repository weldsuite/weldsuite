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

import { generateId } from '@weldsuite/worker-kit/id';

export interface ChatUploadResult {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  fileKey: string;
}

const DEFAULT_R2_PUBLIC_URL = 'https://weldsuite-storage-test.weldsuite.org';

const MAX_FILE_NAME_LENGTH = 200;

/** 128 bits of CSPRNG output as 32 hex characters. */
function randomKeySegment(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A file name safe to use as the last key segment (no path separators or odd characters). */
function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(-MAX_FILE_NAME_LENGTH);
  return cleaned || 'file';
}

/**
 * Store a chat file in R2 and return its public URL + metadata.
 *
 * Files are namespaced per workspace + channel so a stray key can never read
 * across tenants, and carry a 128-bit random segment because the bucket URL is
 * public (anyone holding the URL can read it, so the key must not be guessable):
 * `workspaces/<workspaceId>/chat/<channelId>/files/<128-bit hex>/<fileName>`.
 * The original (sanitised) file name stays the last segment so downloads keep it.
 */
export async function uploadChatFile(params: {
  storage: R2Bucket;
  r2PublicUrl?: string;
  workspaceId: string;
  channelId?: string | null;
  file: File;
  /** When true, refuse to fall back to the test public URL. */
  requirePublicUrl?: boolean;
}): Promise<ChatUploadResult> {
  const { storage, workspaceId, channelId, file } = params;

  const fileId = generateId('chatfile');
  // Sanitize the channelId + filename before they enter the storage key — a
  // crafted channelId ("../other") or filename must never escape the
  // workspace's namespace or manipulate the key.
  const safeChannel = (channelId || 'general').replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
  const storageKey = `workspaces/${workspaceId}/chat/${safeChannel}/files/${randomKeySegment()}/${sanitizeFileName(file.name)}`;

  const arrayBuffer = await file.arrayBuffer();
  await storage.put(storageKey, arrayBuffer, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  const r2PublicUrl = params.r2PublicUrl || (params.requirePublicUrl ? '' : DEFAULT_R2_PUBLIC_URL);
  if (!r2PublicUrl) {
    throw new Error('R2_PUBLIC_URL is required');
  }
  const fileUrl = `${r2PublicUrl.replace(/\/$/, '')}/${storageKey}`;

  return {
    id: fileId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    url: fileUrl,
    fileKey: storageKey,
  };
}
