/**
 * Storage routes — /api/storage/*.
 *
 * 3-step worker-proxied upload flow, port of `apps/api-worker/src/routes/storage.ts`:
 *
 *   1. POST /generate-upload-url   — Clerk-authenticated.
 *   2. PUT  /upload/:token          — token-authenticated (NO Clerk auth).
 *   3. POST /confirm-upload         — Clerk-authenticated.
 *
 * Because `apps/workers/app-api/src/index.ts` applies a global `app.use('/api/*',
 * clerkMiddleware(), workspaceDbMiddleware())`, the token-gated PUT must be
 * mounted BEFORE that middleware. Two routers are exported:
 *
 *   - `storageUploadTokenRoute`  — mounted on the root app pre-middleware
 *                                  (PUT /api/storage/upload/:token, and the
 *                                  GET /api/storage/private/* read)
 *   - `storageRoutes`            — mounted under `/api/storage` after Clerk
 *                                  (/generate-upload-url, /confirm-upload,
 *                                  /access, /sign)
 *
 * Public vs private (TASK-620): `isPublic` picks the bucket.
 *
 *   - public  → `STORAGE`, mapped to the public `R2_PUBLIC_URL` domain. For
 *               avatars, logos and anything shown outside the workspace
 *               (customers, emails, websites). Avatar and app-logo uploads are
 *               always public.
 *   - private → `PRIVATE_STORAGE`, which has no public domain. `file.url` is
 *               the stable `/api/storage/private/<key>` URL on this worker. It
 *               reads only with a files cookie (`POST /access`), a Clerk bearer
 *               token, or a signed URL (`POST /sign`) for the key's workspace.
 *
 * The bucket rules and credentials live in `@weldsuite/worker-kit/storage`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { verifyToken } from '@clerk/backend';
import {
  generateUploadUrlSchema,
  confirmUploadSchema,
} from '@weldsuite/core-api-client/schemas/storage';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { migratePrivateFilesBatch } from '../../services/private-storage-migration';
import { error } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { ALPHANUMERIC, randomString } from '@weldsuite/worker-kit/random';
import {
  FILES_COOKIE,
  PRIVATE_OBJECT_PATH,
  bucketFor,
  cookieValues,
  filesCookiePath,
  isSafeObjectKey,
  keyFromPrivateObjectUrl,
  privateObjectHeaders,
  privateObjectUrl,
  signFilesCookie,
  signPrivateObjectUrl,
  verifyFilesCookie,
  verifyPrivateObjectSignature,
  workspaceOfKey,
  type StorageBucketName,
} from '@weldsuite/worker-kit/storage';

// ============================================================================
// KV-stored upload tokens (10 min TTL).
// ============================================================================

const UPLOAD_TOKEN_PREFIX = 'upload:';
const UPLOAD_TOKEN_TTL = 600;

/**
 * The upload token is the ONLY credential on the unauthenticated
 * `PUT /api/storage/upload/:token`, so it is a secret, not an id: 32
 * CSPRNG characters (~190 bits) instead of `generateId`'s 8.
 */
function generateUploadToken(): string {
  return `upl_${randomString(32, ALPHANUMERIC)}`;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

interface PendingUpload {
  fileKey: string;
  contentType: string;
  fileName: string;
  fileSize: number;
  isPublic: boolean;
  /** Bucket the PUT writes to. Absent on tokens issued before TASK-620: public. */
  bucket?: StorageBucketName;
  userId: string;
  createdAt: number;
}

/** Fixed-key public images: always the public bucket, whatever `isPublic` says. */
const ALWAYS_PUBLIC_ENTITY_TYPES = new Set(['customer-avatar', 'contact-avatar', 'user-app-logo']);

async function setPendingUpload(kv: KVNamespace, token: string, data: PendingUpload) {
  await kv.put(`${UPLOAD_TOKEN_PREFIX}${token}`, JSON.stringify(data), {
    expirationTtl: UPLOAD_TOKEN_TTL,
  });
}

function getPendingUpload(kv: KVNamespace, token: string): Promise<PendingUpload | null> {
  return kv.get<PendingUpload>(`${UPLOAD_TOKEN_PREFIX}${token}`, 'json');
}

async function deletePendingUpload(kv: KVNamespace, token: string) {
  await kv.delete(`${UPLOAD_TOKEN_PREFIX}${token}`);
}

/**
 * Build the URL a browser uses to load a stored object.
 *
 * In deployed envs `R2_PUBLIC_URL` is a domain mapped to the R2 bucket, so we
 * hand back the CDN-style public URL directly. In local `wrangler dev` that
 * domain serves the *remote* bucket, which never has a file just written to
 * Miniflare's local R2 — so for localhost we return a same-origin worker URL
 * that streams the object back through `GET /api/storage/public/*`. Without
 * this, locally-uploaded avatars/files 404 and silently fall back to initials.
 */
function resolvePublicUrl(
  reqUrl: string,
  r2PublicUrl: string | undefined,
  fileKey: string,
): string {
  const origin = new URL(reqUrl).origin;
  if (LOCAL_ORIGIN.test(origin)) {
    return `${origin}/api/storage/public/${fileKey}`;
  }
  const base = r2PublicUrl || 'https://weldsuite-storage-test.weldsuite.org';
  return `${base}/${fileKey}`;
}

/**
 * Which bucket a new upload goes to. Private uploads need `PRIVATE_STORAGE`;
 * production refuses them without it rather than quietly putting a private
 * file on the public domain. Elsewhere (local dev without the binding, an
 * environment mid-rollout) they fall back to the public bucket, which is how
 * every upload behaved before TASK-620.
 */
function chooseUploadBucket(
  env: Env,
  data: { isPublic?: boolean; entityType?: string | null },
): StorageBucketName | null {
  if (data.isPublic || (data.entityType && ALWAYS_PUBLIC_ENTITY_TYPES.has(data.entityType))) {
    return 'public';
  }
  if (env.PRIVATE_STORAGE) return 'private';
  if (env.ENVIRONMENT === 'production') return null;
  console.warn('[app-api/storage] PRIVATE_STORAGE is not bound; private upload goes to the public bucket');
  return 'public';
}

// ============================================================================
// Unauthenticated upload router (mounted pre-middleware)
// ============================================================================

const uploadTokenApp = new Hono<{ Bindings: Env }>();

uploadTokenApp.put('/api/storage/upload/:token', async (c) => {
  const token = c.req.param('token');
  const pending = await getPendingUpload(c.env.WORKSPACE_CACHE, token);
  if (!pending) {
    return c.json({ error: 'Invalid or expired upload token' }, 400);
  }
  const bucket = bucketFor(c.env, pending.bucket ?? 'public');
  if (!bucket) {
    return c.json({ error: 'Storage is not configured' }, 500);
  }
  try {
    const body = await c.req.arrayBuffer();
    const result = await bucket.put(pending.fileKey, body, {
      httpMetadata: { contentType: pending.contentType },
      customMetadata: { fileName: pending.fileName },
    });
    const etag = result?.etag || '';
    return new Response(null, {
      status: 200,
      headers: {
        ETag: etag,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'ETag',
      },
    });
  } catch (err) {
    console.error('[app-api/storage] upload failed:', err);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

/**
 * GET /api/storage/public/* — unauthenticated read that streams an object back
 * through the worker. Its ONLY purpose is local `wrangler dev`, where the R2
 * public bucket domain serves the *remote* bucket and so can't return files
 * that live only in Miniflare's local R2 (see `resolvePublicUrl`).
 *
 * SECURITY: this route is mounted pre-middleware and takes an arbitrary R2 key,
 * so left open it would let any unauthenticated caller read any object in the
 * public bucket in any environment. We therefore FAIL CLOSED and serve only
 * when `ENVIRONMENT === 'development'`, i.e. exactly the local-dev case
 * `resolvePublicUrl` targets (it only ever hands out this worker URL for
 * localhost origins). In test/preview/production the route 404s and public
 * files are served by the mapped R2 domain instead. This mirrors the
 * `ENVIRONMENT !== 'production'` belt-and-braces gate used by `/test-fixtures/*`.
 * It reads `STORAGE` only, never `PRIVATE_STORAGE`.
 *
 * On top of that it only answers requests addressed to localhost: a `wrangler
 * dev` session reachable from elsewhere (a tunnel, a LAN address) must not
 * become an open proxy for whatever bucket STORAGE is bound to.
 */
uploadTokenApp.get('/api/storage/public/*', async (c) => {
  if (c.env.ENVIRONMENT !== 'development' || !LOCAL_ORIGIN.test(new URL(c.req.url).origin)) {
    return c.json({ error: 'Not found' }, 404);
  }
  if (!c.env.STORAGE) {
    return c.json({ error: 'Storage is not configured' }, 500);
  }
  const prefix = '/api/storage/public/';
  const pathname = new URL(c.req.url).pathname;
  const fileKey = decodeURIComponent(pathname.slice(pathname.indexOf(prefix) + prefix.length));
  // Reject empty keys and any traversal/absolute-path trickery in the supplied key.
  if (!fileKey || fileKey.startsWith('/') || fileKey.split('/').includes('..')) {
    return c.json({ error: 'Missing or invalid file key' }, 400);
  }
  const obj = await c.env.STORAGE.get(fileKey);
  if (!obj) {
    return c.json({ error: 'File not found' }, 404);
  }
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(obj.body, { headers });
});

/**
 * May this request read `key` (in `workspaceId`)? Any one of:
 *   1. `?exp=&sig=` signed for this key (`POST /api/storage/sign`);
 *   2. a files cookie for this workspace (`POST /api/storage/access`);
 *   3. a Clerk bearer token whose active organisation is this workspace.
 */
async function authorizePrivateRead(
  c: Context<{ Bindings: Env }>,
  key: string,
  workspaceId: string,
): Promise<boolean> {
  const secret = c.env.STORAGE_SIGNING_KEY;
  if (secret) {
    if (await verifyPrivateObjectSignature(secret, key, c.req.query('exp'), c.req.query('sig'))) {
      return true;
    }
    for (const value of cookieValues(c.req.header('Cookie'), FILES_COOKIE)) {
      if (await verifyFilesCookie(secret, value, workspaceId)) return true;
    }
  }
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = await verifyToken(auth.slice(7), {
        secretKey: c.env.CLERK_SECRET_KEY,
        ...(c.env.CLERK_JWT_KEY ? { jwtKey: c.env.CLERK_JWT_KEY } : {}),
      });
      const claims = payload as typeof payload & { o?: { id?: string }; org_id?: string };
      return !!payload.sub && (claims.o?.id || claims.org_id) === workspaceId;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * GET /api/storage/private/<key> — the only way to read a private object.
 *
 * The key's own `workspaces/<id>/` prefix names the tenant; the caller must
 * prove membership of THAT workspace (see `authorizePrivateRead`). A missing
 * credential is a 401, a wrong one or an unknown key a 404, so the route never
 * confirms that another tenant's key exists. Served with `private` caching,
 * a sandboxing CSP and `attachment` for anything that could run script.
 * Supports `Range` so `<video>` and `<audio>` can seek.
 */
uploadTokenApp.get(`${PRIVATE_OBJECT_PATH}*`, async (c) => {
  const key = keyFromPrivateObjectUrl(c.req.url);
  const workspaceId = key ? workspaceOfKey(key) : null;
  if (!key || !workspaceId) return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);

  if (!(await authorizePrivateRead(c, key, workspaceId))) {
    const hasCredential =
      !!c.req.query('sig') ||
      !!c.req.header('Authorization') ||
      cookieValues(c.req.header('Cookie'), FILES_COOKIE).length > 0;
    return hasCredential
      ? c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404)
      : c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in to open this file' } }, 401);
  }

  if (!c.env.PRIVATE_STORAGE) return error.internal(c, 'Private storage is not configured');
  const range = c.req.header('Range');
  const obj = await c.env.PRIVATE_STORAGE.get(key, range ? { range: c.req.raw.headers } : undefined);
  if (!obj || !('body' in obj)) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);
  }
  const headers = privateObjectHeaders(obj, obj.customMetadata?.fileName);
  // A 206 only when R2 actually served a sub-range of the object.
  const r = obj.range as { offset?: number; length?: number } | undefined;
  if (range && r && typeof r.offset === 'number') {
    const length = r.length ?? obj.size - r.offset;
    headers.set('Content-Range', `bytes ${r.offset}-${r.offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
});

export const storageUploadTokenRoute = uploadTokenApp;

// ============================================================================
// Authenticated routes — generate + confirm, files cookie, signed URLs
// ============================================================================

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GATE DECISION (no `requirePermission`): storage is a GENERIC, cross-module
 * upload broker. The same two endpoints back avatar uploads (customer/contact
 * logos), drive files, mail attachments, helpdesk uploads, accounting receipt
 * scans, etc. — callers that legitimately hold very different object
 * permissions (`customers:update`, `files:create`, `conversations:update`, …).
 * No single object permission key fits all of them, and pinning one (e.g.
 * `files:create`) would 403 every non-files caller and break uploads.
 *
 * Auth is therefore enforced by the layers these routes are already mounted
 * behind — the global `app.use('/api/*', clerkMiddleware(), workspaceDbMiddleware())`
 * in `src/index.ts` requires a valid Clerk session AND a resolved tenant
 * workspace before either handler runs. On top of that the handlers below
 * assert `userId` (authenticated principal) and `workspaceId` (tenant scope)
 * inline, and every generated `fileKey` is namespaced under
 * `workspaces/${workspaceId}/…` so a token can only ever target the caller's
 * own tenant bucket prefix. That is the correct gate for a workspace-member
 * upload broker; adding an object `requirePermission` here would be incorrect.
 * The same holds for `/access` and `/sign`: they grant reads of the caller's
 * own workspace's private objects, nothing more.
 */
app.post(
  '/generate-upload-url',
  zValidator('json', generateUploadUrlSchema),
  async (c) => {
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const workspaceId = c.get('workspaceId') || c.get('orgId');
    if (!workspaceId) return error.orgRequired(c);

    const data = c.req.valid('json');
    const bucket = chooseUploadBucket(c.env, data);
    if (!bucket) return error.unavailable(c, 'Private storage is not configured');

    try {
      const uploadToken = generateUploadToken();
      let fileKey: string;

      if (data.entityType === 'customer-avatar' && data.entityId) {
        const ext = data.fileName.split('.').pop()?.toLowerCase() || 'png';
        fileKey = `workspaces/${workspaceId}/avatars/customers/${data.entityId}/logo.${ext}`;
      } else if (data.entityType === 'contact-avatar' && data.entityId) {
        const ext = data.fileName.split('.').pop()?.toLowerCase() || 'png';
        fileKey = `workspaces/${workspaceId}/avatars/contacts/${data.entityId}/logo.${ext}`;
      } else if (data.entityType === 'user-app-logo' && data.entityId) {
        const ext = data.fileName.split('.').pop()?.toLowerCase() || 'png';
        fileKey = `workspaces/${workspaceId}/user-apps/${data.entityId}/logo.${ext}`;
      } else {
        const timestamp = Date.now();
        const sanitizedName = data.fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const folder = data.folder || 'uploads';
        const entityPath =
          data.entityType && data.entityId ? `${data.entityType}/${data.entityId}` : 'general';
        // Public files are served from the bucket URL without auth, so the key
        // is the only thing protecting them: it must not be guessable from the
        // workspace id, upload time and file name alone.
        const unguessable = crypto.randomUUID().replace(/-/g, '');
        fileKey = `workspaces/${workspaceId}/${folder}/${entityPath}/${timestamp}_${unguessable}/${sanitizedName}`;
      }

      await setPendingUpload(c.env.WORKSPACE_CACHE, uploadToken, {
        fileKey,
        contentType: data.contentType,
        fileName: data.fileName,
        fileSize: data.fileSize,
        isPublic: bucket === 'public',
        bucket,
        userId,
        createdAt: Date.now(),
      });

      const origin = new URL(c.req.url).origin;
      const uploadUrl = `${origin}/api/storage/upload/${uploadToken}`;

      return c.json({ success: true, uploadUrl, uploadToken, fileKey, bucket });
    } catch (err) {
      console.error('[app-api/storage] generate-upload-url failed:', err);
      return error.internal(c, 'Failed to generate upload URL');
    }
  },
);

app.post(
  '/confirm-upload',
  zValidator('json', confirmUploadSchema),
  async (c) => {
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);

    const { uploadToken, fileKey: requestedKey } = c.req.valid('json');

    const pending = await getPendingUpload(c.env.WORKSPACE_CACHE, uploadToken);
    if (!pending || pending.userId !== userId) {
      return c.json({ success: false, error: 'Invalid or expired upload token' }, 400);
    }
    // The key comes from the token, never from the request: a caller-supplied
    // key would turn this into a size/URL oracle for any object in the bucket,
    // other tenants' included.
    const fileKey = pending.fileKey;
    if (requestedKey !== fileKey) {
      return error.badRequest(c, 'File key does not match the upload token');
    }
    await deletePendingUpload(c.env.WORKSPACE_CACHE, uploadToken);

    const bucketName = pending.bucket ?? 'public';
    const bucket = bucketFor(c.env, bucketName);
    if (!bucket) {
      return error.internal(c, 'Storage is not configured');
    }

    try {
      const head = await bucket.head(fileKey);
      if (!head) {
        return c.json({ success: false, error: 'File not found in storage' }, 400);
      }
      const url =
        bucketName === 'private'
          ? privateObjectUrl(new URL(c.req.url).origin, fileKey)
          : resolvePublicUrl(c.req.url, c.env.R2_PUBLIC_URL, fileKey);
      const fileId = generateId('file');

      return c.json({
        success: true,
        file: {
          id: fileId,
          fileName: pending.fileName,
          fileKey,
          fileSize: head.size,
          mimeType: pending.contentType,
          url,
          isPublic: bucketName === 'public',
          bucket: bucketName,
        },
      });
    } catch (err) {
      console.error('[app-api/storage] confirm-upload failed:', err);
      return c.json({ success: false, error: 'Failed to confirm upload' }, 500);
    }
  },
);

function filesCookieHeader(c: Context, workspaceId: string, value: string, maxAge: number): string {
  const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
  return `${FILES_COOKIE}=${value}; Path=${filesCookiePath(workspaceId)}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * POST /api/storage/access — set the files cookie for the caller's workspace,
 * so the browser can load that workspace's private URLs in `<img>`, `<a>` and
 * `<video>` without a bearer header. Path-scoped to the workspace's key prefix
 * and short-lived; the platform calls this again before `expiresAt`. Needs
 * `credentials: 'include'` on the fetch (app-api's CORS allows credentials
 * for first-party origins).
 */
app.post('/access', async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const workspaceId = c.get('workspaceId') || c.get('orgId');
  if (!workspaceId) return error.orgRequired(c);
  const secret = c.env.STORAGE_SIGNING_KEY;
  if (!secret) return error.unavailable(c, 'File access signing is not configured');

  const { value, expiresAt } = await signFilesCookie(secret, workspaceId);
  c.header('Set-Cookie', filesCookieHeader(c, workspaceId, value, expiresAt - Math.floor(Date.now() / 1000)));
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { workspaceId, expiresAt } });
});

/** DELETE /api/storage/access — drop the caller's files cookie (sign-out). */
app.delete('/access', async (c) => {
  const workspaceId = c.get('workspaceId') || c.get('orgId');
  if (!workspaceId) return error.orgRequired(c);
  c.header('Set-Cookie', filesCookieHeader(c, workspaceId, '', 0));
  return c.body(null, 204);
});

const signSchema = z.object({
  /** Private object URLs or bare keys, at most 100. */
  files: z.array(z.string().min(1)).min(1).max(100),
  ttlSeconds: z.number().int().min(30).max(24 * 60 * 60).optional(),
});

/**
 * POST /api/storage/sign — short-lived URLs for private objects of the
 * caller's workspace, for clients that can send neither the cookie nor a
 * bearer header (a native viewer, a share sheet, a third party the caller
 * hands the file to). Anything outside the workspace is left out of the map.
 */
app.post('/sign', zValidator('json', signSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const workspaceId = c.get('workspaceId') || c.get('orgId');
  if (!workspaceId) return error.orgRequired(c);
  const secret = c.env.STORAGE_SIGNING_KEY;
  if (!secret) return error.unavailable(c, 'File access signing is not configured');

  const { files, ttlSeconds } = c.req.valid('json');
  const origin = new URL(c.req.url).origin;
  const urls: Record<string, { url: string; expiresAt: number }> = {};
  for (const ref of files) {
    const key = keyFromPrivateObjectUrl(ref) ?? (isSafeObjectKey(ref) ? ref : null);
    if (!key || workspaceOfKey(key) !== workspaceId) continue;
    urls[ref] = await signPrivateObjectUrl(secret, origin, key, ttlSeconds);
  }
  return c.json({ data: urls });
});

const migrateSchema = z.object({
  cursor: z.string().nullish(),
  dryRun: z.boolean().optional(),
});

/**
 * POST /api/storage/migrate-private — move one batch of this workspace's
 * existing private drive files from the public bucket to the private one
 * (`services/private-storage-migration.ts`). The caller loops, passing back
 * `cursor`, until `done`; `dryRun` only counts. Gated like
 * `POST /api/search/reindex`: a workspace-wide administrative action.
 */
app.post(
  '/migrate-private',
  requirePermission('settings:general:update'),
  zValidator('json', migrateSchema),
  async (c) => {
    const workspaceId = c.get('workspaceId') || c.get('orgId');
    if (!workspaceId) return error.orgRequired(c);
    if (!c.env.STORAGE || !c.env.PRIVATE_STORAGE) {
      return error.unavailable(c, 'Private storage is not configured');
    }
    const { cursor, dryRun } = c.req.valid('json');
    try {
      const result = await migratePrivateFilesBatch({
        db: c.get('tenantDb'),
        env: c.env,
        workspaceId,
        apiOrigin: new URL(c.req.url).origin,
        cursor,
        dryRun,
      });
      return c.json({ data: result });
    } catch (err) {
      console.error('[app-api/storage] migrate-private failed:', err);
      return error.internal(c, 'Failed to move private files');
    }
  },
);

export const storageRoutes = app;
