/**
 * Pure helpers for the storage upload broker (`routes/storage`):
 *
 *   - request validation for `POST /generate-upload-url` (hostile path
 *     segments, size cap),
 *   - R2 key construction,
 *   - the content-type policy for stored objects,
 *   - an exact-size body reader for the token-authenticated PUT.
 *
 * No Hono context in here, so every rule is unit-testable on its own.
 */

import { z } from 'zod';
import { generateUploadUrlSchema } from '@weldsuite/core-api-client/schemas/storage';

// ============================================================================
// Limits
// ============================================================================

/**
 * Hard cap on one brokered upload. The PUT is proxied through the worker and
 * buffered in memory (an isolate has 128 MB), and Cloudflare itself refuses
 * request bodies above 100 MB on most plans, so nothing larger worked before
 * either. The biggest client-side limits in the apps are 50 MB (chat, editor
 * media).
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const MAX_FILE_NAME_LENGTH = 255;
const MAX_FOLDER_SEGMENTS = 3;

// ============================================================================
// Path-segment validation (finding 667)
// ============================================================================

/**
 * One `folder` / `entityType` segment. Lowercase letters, digits, `_` and `-`
 * only: no dots (so never `.` or `..`), no slashes, no percent-escapes. Such a
 * segment is left alone by URL normalisation, so the public URL of an object
 * can never resolve under another prefix than the key it was written to.
 */
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** `entityId`: the `generateId` charset (also Clerk ids and UUIDs). */
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A folder is one to three safe segments joined by `/` (callers send
 * `documents/content` and `weldbooks/documents`). Every segment must be safe on
 * its own, so empty segments, `.`/`..`, a leading or trailing slash and
 * backslashes are all rejected.
 */
export function isSafeFolder(value: string): boolean {
  const segments = value.split('/');
  return segments.length <= MAX_FOLDER_SEGMENTS && segments.every((s) => SEGMENT.test(s));
}

export function isSafeEntityType(value: string): boolean {
  return SEGMENT.test(value);
}

export function isSafeEntityId(value: string): boolean {
  return ENTITY_ID.test(value);
}

/** Callers pass '' for "none" (block editor: `entityId || projectId || ''`). */
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

/**
 * The shared request schema plus the server-side rules. Anything hostile is a
 * 400 (zValidator), never silently rewritten.
 */
export const generateUploadUrlRequestSchema = generateUploadUrlSchema.extend({
  fileName: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  fileSize: z
    .number()
    .int()
    .min(0)
    .max(MAX_UPLOAD_BYTES, `fileSize must not exceed ${MAX_UPLOAD_BYTES} bytes`),
  folder: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine(isSafeFolder, {
        message: `folder must be 1-${MAX_FOLDER_SEGMENTS} segments of lowercase letters, digits, '-' or '_', separated by '/'`,
      })
      .optional(),
  ),
  entityType: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine(isSafeEntityType, {
        message: "entityType must be lowercase letters, digits, '-' or '_' (max 48 characters)",
      })
      .optional(),
  ),
  entityId: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine(isSafeEntityId, {
        message: "entityId must be letters, digits, '-' or '_' (max 64 characters)",
      })
      .nullish(),
  ),
});

export type GenerateUploadUrlRequest = z.infer<typeof generateUploadUrlRequestSchema>;

// ============================================================================
// Key construction
// ============================================================================

/**
 * `a.PNG` -> `png`. Only a short alphanumeric extension is kept; anything
 * else (slashes, spaces, a name with no dot at all) falls back to `png`.
 */
export function avatarExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'png';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'png';
}

/** Keep letters, digits, `.`, `-`, `_`; a name made only of dots becomes `file`. */
export function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  return /^\.*$/.test(cleaned) ? 'file' : cleaned;
}

export interface UploadKey {
  fileKey: string;
  /**
   * True when the key carries a random segment, so it is written exactly once.
   * Avatar and app-logo keys are deterministic (`.../logo.png`) and a re-upload
   * is meant to replace them.
   */
  createOnly: boolean;
}

/**
 * Build the R2 key for an upload. `input` must already have passed
 * `generateUploadUrlRequestSchema`; the workspace id comes from the
 * authenticated session, never from the request.
 */
export function buildUploadKey(
  workspaceId: string,
  input: Pick<GenerateUploadUrlRequest, 'fileName' | 'folder' | 'entityType' | 'entityId'>,
): UploadKey {
  const { fileName, folder, entityType, entityId } = input;

  if (entityType === 'customer-avatar' && entityId) {
    return {
      fileKey: `workspaces/${workspaceId}/avatars/customers/${entityId}/logo.${avatarExtension(fileName)}`,
      createOnly: false,
    };
  }
  if (entityType === 'contact-avatar' && entityId) {
    return {
      fileKey: `workspaces/${workspaceId}/avatars/contacts/${entityId}/logo.${avatarExtension(fileName)}`,
      createOnly: false,
    };
  }
  if (entityType === 'user-app-logo' && entityId) {
    return {
      fileKey: `workspaces/${workspaceId}/user-apps/${entityId}/logo.${avatarExtension(fileName)}`,
      createOnly: false,
    };
  }

  const timestamp = Date.now();
  const entityPath = entityType && entityId ? `${entityType}/${entityId}` : 'general';
  // Public files are served from the bucket URL without auth, so the key is the
  // only thing protecting them: it must not be guessable from the workspace id,
  // upload time and file name alone.
  const unguessable = crypto.randomUUID().replace(/-/g, '');
  return {
    fileKey: `workspaces/${workspaceId}/${folder || 'uploads'}/${entityPath}/${timestamp}_${unguessable}/${sanitizeFileName(fileName)}`,
    createOnly: true,
  };
}

// ============================================================================
// Content-type policy (finding 665)
// ============================================================================

/**
 * Objects are served from a public bucket domain on a weldsuite.org host, so a
 * stored `text/html` (or SVG, XML, JS...) would run as a page of that host. The
 * type the client declares is therefore only honoured when it is on this list
 * of types a browser displays or plays without executing; everything else is
 * stored as `application/octet-stream` with `Content-Disposition: attachment`.
 */
const INLINE_EXACT = new Set([
  // Raster images (no SVG: it is a document that can carry script).
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  // Documents
  'application/pdf',
  'application/rtf',
  'text/rtf',
  'application/msword',
  'application/epub+zip',
  // Text a browser shows as text
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'text/markdown',
  'text/calendar',
  'text/vcard',
  'application/json',
  // Archives
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
]);

/** Families where the whole subtype space is passive (media, office formats). */
const INLINE_PREFIXES = [
  'audio/',
  'video/',
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.oasis.opendocument.',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-word',
  'application/vnd.ms-outlook',
];

/** A syntactically plain `type/subtype` (RFC 6838 restricted-name chars). */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export const SAFE_FALLBACK_TYPE = 'application/octet-stream';

export interface StoredContent {
  /** What goes into R2 `httpMetadata.contentType`. */
  contentType: string;
  /** Set when the object must never render inline. */
  contentDisposition?: 'attachment';
}

/**
 * Decide how an object is stored and served, from the content type the client
 * declared. Parameters (`; charset=...`, `;codecs=...`) are dropped.
 */
export function resolveStoredContent(declared: string): StoredContent {
  const base = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    MEDIA_TYPE.test(base) &&
    (INLINE_EXACT.has(base) || INLINE_PREFIXES.some((prefix) => base.startsWith(prefix)))
  ) {
    return { contentType: base };
  }
  return { contentType: SAFE_FALLBACK_TYPE, contentDisposition: 'attachment' };
}

// ============================================================================
// Exact-size body reader (finding 665)
// ============================================================================

export type ExactBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' | 'size_mismatch' };

/**
 * Read a request body that must be exactly `expected` bytes. A `Content-Length`
 * that disagrees is refused before any byte is read; without one (chunked) the
 * stream is counted and cut off as soon as it passes `expected`. Memory is
 * bounded by `expected`, which the caller has already capped.
 */
export async function readBodyOfExactSize(request: Request, expected: number): Promise<ExactBody> {
  const declared = checkDeclaredLength(request.headers.get('content-length'), expected);
  if (declared) return { ok: false, reason: declared };

  const bytes = new Uint8Array(expected);
  const read = request.body ? await readInto(request.body, bytes) : { ok: true as const, length: 0 };
  if (!read.ok) return { ok: false, reason: 'too_large' };
  if (read.length !== expected) return { ok: false, reason: 'size_mismatch' };
  return { ok: true, bytes };
}

/** Why a `Content-Length` header rules the body out, or null when it is absent or agrees. */
function checkDeclaredLength(header: string | null, expected: number): 'too_large' | 'size_mismatch' | null {
  if (header === null) return null;
  const declared = Number(header);
  if (!Number.isInteger(declared) || declared < 0) return 'size_mismatch';
  if (declared > expected) return 'too_large';
  return declared === expected ? null : 'size_mismatch';
}

/** Stream `body` into `target`, cancelling as soon as it would overflow. */
async function readInto(
  body: ReadableStream<Uint8Array>,
  target: Uint8Array,
): Promise<{ ok: true; length: number } | { ok: false }> {
  const reader = body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { ok: true, length: offset };
    if (offset + value.byteLength > target.byteLength) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    target.set(value, offset);
    offset += value.byteLength;
  }
}
