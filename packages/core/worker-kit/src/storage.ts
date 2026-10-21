/**
 * Stored files: which bucket holds an object, and who may read a private one.
 *
 * Two R2 buckets per environment (TASK-620):
 *
 *   - `STORAGE` is mapped to a public domain (`R2_PUBLIC_URL`). Anything in it
 *     can be fetched by anyone who has the URL, so it holds only what is meant
 *     to be public: avatars, logos, images embedded in emails, invoices and
 *     websites, attachments sent to customers.
 *   - `PRIVATE_STORAGE` has no public domain. Its objects are served only by
 *     app-api's `GET /api/storage/private/<key>`, to a member of the workspace
 *     the key belongs to (see {@link authorizePrivateRead}).
 *
 * Keys look the same in both buckets (`workspaces/<workspaceId>/…`), so moving
 * an object from one to the other never changes its key. Server-side readers
 * use {@link getStoredObject} / {@link deleteStoredObject}, which look in the
 * private bucket first and fall back to the public one, so they keep working
 * for objects uploaded before the split and for objects moved later.
 *
 * A private object's URL is `<app-api origin>/api/storage/private/<key>`. It is
 * stable (safe to store in a row) and useless on its own: a request needs one
 * of
 *   - a short-lived files cookie for that workspace (browsers: `<img>`,
 *     `<a href>`, `<video>` send it without any code at the render site),
 *   - a Clerk bearer token whose active organisation is that workspace
 *     (mobile apps, `fetch` with an Authorization header), or
 *   - a signed URL (`?exp=&sig=`) minted for that key by a member, for the few
 *     places that can send neither (a native viewer, a third party).
 */

/** Path app-api serves private objects under. */
export const PRIVATE_OBJECT_PATH = '/api/storage/private/';

/** Name of the per-workspace files cookie (one per workspace, path-scoped). */
export const FILES_COOKIE = 'ws_files';

/** Files cookie lifetime. The platform refreshes it well before it lapses. */
export const FILES_COOKIE_TTL_SECONDS = 60 * 60;

/** Default and maximum lifetime of a signed object URL. */
export const SIGNED_URL_TTL_SECONDS = 15 * 60;
export const SIGNED_URL_MAX_TTL_SECONDS = 24 * 60 * 60;

export type StorageBucketName = 'public' | 'private';

export interface StorageBindings {
  STORAGE?: R2Bucket;
  PRIVATE_STORAGE?: R2Bucket;
}

// ============================================================================
// Keys and URLs
// ============================================================================

const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/** The workspace a key belongs to (`workspaces/<id>/…`), or null. */
export function workspaceOfKey(key: string): string | null {
  const parts = key.split('/');
  if (parts.length < 3 || parts[0] !== 'workspaces') return null;
  const id = parts[1];
  return id && WORKSPACE_ID.test(id) ? id : null;
}

/** A key with no traversal, absolute-path or empty-segment tricks. */
export function isSafeObjectKey(key: string): boolean {
  if (!key || key.length > 1000 || key.startsWith('/')) return false;
  return !key.split('/').some((s) => s === '' || s === '.' || s === '..');
}

/** `value` without any run of `char` at its end (no regex, so no backtracking). */
function trimTrailing(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end--;
  return value.slice(0, end);
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** Stable URL of a private object, served by app-api at `apiOrigin`. */
export function privateObjectUrl(apiOrigin: string, key: string): string {
  return `${trimTrailing(apiOrigin, '/')}${PRIVATE_OBJECT_PATH}${encodeKey(key)}`;
}

/** The key of a private object URL (any host), or null for any other URL. */
export function keyFromPrivateObjectUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(PRIVATE_OBJECT_PATH)) return null;
  try {
    const key = decodeURIComponent(pathname.slice(PRIVATE_OBJECT_PATH.length));
    return isSafeObjectKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** URL of a public object on the bucket's public domain. */
export function publicObjectUrl(r2PublicUrl: string, key: string): string {
  return `${trimTrailing(r2PublicUrl, '/')}/${key}`;
}

// ============================================================================
// Bucket resolution for server-side readers
// ============================================================================

/** The binding for a bucket name (undefined when the worker lacks it). */
export function bucketFor(env: StorageBindings, bucket: StorageBucketName): R2Bucket | undefined {
  return bucket === 'private' ? env.PRIVATE_STORAGE : env.STORAGE;
}

/**
 * Read an object wherever it lives: the private bucket first, then the public
 * one. Accepts the same options as `R2Bucket.get` (ranges, conditionals).
 */
export async function getStoredObject(
  env: StorageBindings,
  key: string,
  options?: R2GetOptions,
): Promise<R2ObjectBody | null> {
  // A conditional get whose precondition fails returns the object without a
  // body: it exists here, so don't fall through to the other bucket.
  const asBody = (obj: R2Object | R2ObjectBody | null) =>
    obj && (!options?.onlyIf || 'body' in obj) ? (obj as R2ObjectBody) : null;
  if (env.PRIVATE_STORAGE) {
    const obj = await env.PRIVATE_STORAGE.get(key, options);
    if (obj) return asBody(obj);
  }
  if (!env.STORAGE) return null;
  return asBody(await env.STORAGE.get(key, options));
}

/** Which bucket holds `key` (private wins), with its metadata. */
export async function locateStoredObject(
  env: StorageBindings,
  key: string,
): Promise<{ bucket: StorageBucketName; head: R2Object } | null> {
  if (env.PRIVATE_STORAGE) {
    const head = await env.PRIVATE_STORAGE.head(key);
    if (head) return { bucket: 'private', head };
  }
  if (env.STORAGE) {
    const head = await env.STORAGE.head(key);
    if (head) return { bucket: 'public', head };
  }
  return null;
}

/**
 * Overwrite an existing object in the bucket that already holds it, so an
 * edit never moves a private file into the public bucket. A new key goes to
 * `fallback` (default private when the worker has it).
 */
export async function putStoredObject(
  env: StorageBindings,
  key: string,
  body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
  options?: R2PutOptions,
  fallback?: StorageBucketName,
): Promise<{ bucket: StorageBucketName; object: R2Object | null }> {
  const located = await locateStoredObject(env, key);
  const bucket: StorageBucketName =
    located?.bucket ?? fallback ?? (env.PRIVATE_STORAGE ? 'private' : 'public');
  const target = bucketFor(env, bucket);
  if (!target) throw new Error(`Storage bucket "${bucket}" is not configured`);
  return { bucket, object: await target.put(key, body, options) };
}

/** Delete `key` from both buckets (idempotent; a missing object is fine). */
export async function deleteStoredObject(env: StorageBindings, key: string): Promise<void> {
  await Promise.all([env.PRIVATE_STORAGE?.delete(key), env.STORAGE?.delete(key)]);
}

// ============================================================================
// Signing (HMAC-SHA256 under STORAGE_SIGNING_KEY)
// ============================================================================

const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return trimTrailing(btoa(s).replaceAll('+', '-').replaceAll('/', '_'), '=');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function safeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Each credential signs its own purpose string, so a cookie value can never be
// replayed as a URL signature or the other way round.
const cookieMessage = (workspaceId: string, exp: number) => `ws-files-cookie:v1:${workspaceId}:${exp}`;
const urlMessage = (key: string, exp: number) => `ws-files-url:v1:${key}:${exp}`;

/** Files cookie value granting read access to one workspace's private objects. */
export async function signFilesCookie(
  secret: string,
  workspaceId: string,
  ttlSeconds = FILES_COOKIE_TTL_SECONDS,
): Promise<{ value: string; expiresAt: number }> {
  const exp = nowSeconds() + ttlSeconds;
  const sig = await hmac(secret, cookieMessage(workspaceId, exp));
  return { value: `v1.${workspaceId}.${exp}.${sig}`, expiresAt: exp };
}

/** True when `value` is an unexpired files cookie for `workspaceId`. */
export async function verifyFilesCookie(
  secret: string,
  value: string,
  workspaceId: string,
): Promise<boolean> {
  const [version, ws, expRaw, sig] = value.split('.');
  if (version !== 'v1' || ws !== workspaceId || !sig) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp < nowSeconds()) return false;
  return safeEqual(sig, await hmac(secret, cookieMessage(ws, exp)));
}

/** The Path a workspace's files cookie is scoped to. */
export function filesCookiePath(workspaceId: string): string {
  return `${PRIVATE_OBJECT_PATH}workspaces/${workspaceId}/`;
}

/** A short-lived URL that reads one private object without any other credential. */
export async function signPrivateObjectUrl(
  secret: string,
  apiOrigin: string,
  key: string,
  ttlSeconds = SIGNED_URL_TTL_SECONDS,
): Promise<{ url: string; expiresAt: number }> {
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), SIGNED_URL_MAX_TTL_SECONDS);
  const exp = nowSeconds() + ttl;
  const sig = await hmac(secret, urlMessage(key, exp));
  return { url: `${privateObjectUrl(apiOrigin, key)}?exp=${exp}&sig=${sig}`, expiresAt: exp };
}

/** True when `exp`/`sig` are a valid, unexpired signature for `key`. */
export async function verifyPrivateObjectSignature(
  secret: string,
  key: string,
  expRaw: string | undefined,
  sig: string | undefined,
): Promise<boolean> {
  if (!expRaw || !sig) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp < nowSeconds() || exp > nowSeconds() + SIGNED_URL_MAX_TTL_SECONDS) {
    return false;
  }
  return safeEqual(sig, await hmac(secret, urlMessage(key, exp)));
}

/** Every value of cookie `name` in a Cookie header (path-scoped cookies can repeat). */
export function cookieValues(header: string | undefined | null, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

// ============================================================================
// Serving
// ============================================================================

/**
 * Types a browser may render inline from the app-api origin. Anything else
 * (HTML, SVG, XML, scripts, unknown) is served as an attachment, so an
 * uploaded file can never run script on app-api's origin.
 */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
]);
/** Any `video/*` or `audio/*` subtype (letters, digits and `.+-` only). */
const MEDIA_TYPE = /^(?:video|audio)\/[\w.+-]+$/;

export function isInlineSafeContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return INLINE_TYPES.has(type) || MEDIA_TYPE.test(type);
}

/** Response headers for a private object (no shared caching, no script). */
export function privateObjectHeaders(obj: R2Object, fileName?: string): Headers {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Chrome refuses to render a PDF in a sandboxed document, so PDFs (inline,
  // in the browser's own viewer) go without; everything else gets no script.
  if (!/^application\/pdf\b/i.test(headers.get('content-type') ?? '')) {
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  }
  headers.set('Accept-Ranges', 'bytes');
  const name = (fileName ?? obj.key.split('/').pop() ?? 'file').replace(/["\\\r\n]/g, '_');
  const disposition = isInlineSafeContentType(headers.get('content-type')) ? 'inline' : 'attachment';
  headers.set('Content-Disposition', `${disposition}; filename="${name}"`);
  return headers;
}
