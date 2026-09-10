/**
 * Upload helpers for WeldSocial media assets.
 *
 * Agents cannot hit the browser's 3-step storage flow, so MCP accepts either
 * base64 bytes or a source URL, stores the object in R2, and returns a public
 * URL suitable for PostPeer (and for attaching via mediaIds on a post).
 */

import { generateId } from '../../../lib/id';

const DEFAULT_R2_PUBLIC_URL = 'https://weldsuite-storage-test.weldsuite.org';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

export class SocialMediaUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500 = 400,
  ) {
    super(message);
    this.name = 'SocialMediaUploadError';
  }
}

export function guessMediaType(
  fileName: string,
  mimeType?: string,
  explicit?: string,
): 'image' | 'video' | 'gif' {
  if (explicit === 'image' || explicit === 'video' || explicit === 'gif') return explicit;
  if (mimeType === 'image/gif' || fileName.toLowerCase().endsWith('.gif')) return 'gif';
  if (mimeType?.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(fileName)) return 'video';
  return 'image';
}

export function guessMime(fileName: string, mediaType: string, provided?: string): string {
  if (provided) return provided;
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (mediaType === 'video') return 'video/mp4';
  if (mediaType === 'gif') return 'image/gif';
  return 'image/png';
}

function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() || 'asset';
  return base.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 180) || 'asset';
}

function decodeBase64(contentBase64: string): Uint8Array {
  const cleaned = contentBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new SocialMediaUploadError('contentBase64 is not valid base64');
  }
}

function publicUrlFor(r2PublicUrl: string | undefined, fileKey: string): string {
  const base = (r2PublicUrl || DEFAULT_R2_PUBLIC_URL).replace(/\/$/, '');
  return `${base}/${fileKey}`;
}

export interface StoredSocialMediaFile {
  fileName: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  mediaType: 'image' | 'video' | 'gif';
  storagePath: string;
  url: string;
}

/**
 * Put bytes into R2 under the workspace social-media namespace and return
 * metadata for a `social_media` row.
 */
export async function storeSocialMediaBytes(params: {
  storage: R2Bucket;
  r2PublicUrl?: string;
  workspaceId: string;
  /** When set, used in the R2 key so it matches the social_media row id. */
  assetId?: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType?: string;
  mediaType?: string;
}): Promise<StoredSocialMediaFile> {
  const { storage, workspaceId, bytes } = params;
  if (bytes.byteLength === 0) {
    throw new SocialMediaUploadError('Uploaded file is empty');
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new SocialMediaUploadError(
      `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`,
    );
  }

  const originalName = sanitizeFileName(params.fileName);
  const mediaType = guessMediaType(originalName, params.mimeType, params.mediaType);
  const mimeType = guessMime(originalName, mediaType, params.mimeType);

  const allowed =
    ALLOWED_MIME.has(mimeType) ||
    mimeType === 'image/jpg' ||
    mimeType.startsWith('image/') ||
    mimeType.startsWith('video/');
  if (!allowed) {
    throw new SocialMediaUploadError(`Unsupported media type: ${mimeType}`);
  }

  const assetId = params.assetId || generateId('smed');
  const storagePath = `workspaces/${workspaceId}/social-media/${assetId}/${originalName}`;

  await storage.put(storagePath, bytes, {
    httpMetadata: { contentType: mimeType },
  });

  return {
    fileName: originalName,
    originalName,
    mimeType,
    fileSize: bytes.byteLength,
    mediaType,
    storagePath,
    url: publicUrlFor(params.r2PublicUrl, storagePath),
  };
}

export async function loadBytesFromSourceUrl(sourceUrl: string): Promise<{
  bytes: Uint8Array;
  mimeType?: string;
  fileName?: string;
}> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new SocialMediaUploadError('sourceUrl is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SocialMediaUploadError('sourceUrl must be http(s)');
  }

  const res = await fetch(sourceUrl, { redirect: 'follow' });
  if (!res.ok) {
    throw new SocialMediaUploadError(`Failed to fetch sourceUrl (${res.status})`);
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    throw new SocialMediaUploadError(
      `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`,
    );
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    throw new SocialMediaUploadError(
      `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`,
    );
  }

  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || undefined;
  const pathName = parsed.pathname.split('/').pop() || undefined;
  return { bytes: buf, mimeType, fileName: pathName };
}

export async function resolveUploadBytes(input: {
  contentBase64?: string;
  sourceUrl?: string;
}): Promise<{ bytes: Uint8Array; mimeType?: string; fileName?: string }> {
  if (input.contentBase64) {
    return { bytes: decodeBase64(input.contentBase64) };
  }
  if (input.sourceUrl) {
    return loadBytesFromSourceUrl(input.sourceUrl);
  }
  throw new SocialMediaUploadError('Provide contentBase64 or sourceUrl');
}
