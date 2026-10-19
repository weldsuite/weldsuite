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
 *                                  (handles only PUT /api/storage/upload/:token)
 *   - `storageRoutes`            — mounted under `/api/storage` after Clerk
 *                                  (handles /generate-upload-url + /confirm-upload)
 *
 * What the token-gated PUT enforces (the token is the only credential there):
 *   - the body is exactly the `fileSize` declared at mint time (and below the
 *     hard cap), checked on `Content-Length` before reading and on the bytes;
 *   - the token writes ONCE: the pending record is flagged `uploaded` and a
 *     second PUT is a 409 (keys with a random segment are also written with an
 *     R2 create-only precondition, which is atomic where KV is not);
 *   - the stored content type is allowlisted; anything that could run as a
 *     page of the public bucket host is stored as an attachment octet-stream.
 * `confirm-upload` still works after the PUT: it reads the object from R2.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { confirmUploadSchema } from '@weldsuite/core-api-client/schemas/storage';
import type { Env, Variables } from '../../types';
import { error } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { ALPHANUMERIC, randomString } from '@weldsuite/worker-kit/random';
import {
  MAX_UPLOAD_BYTES,
  buildUploadKey,
  generateUploadUrlRequestSchema,
  readBodyOfExactSize,
  resolveStoredContent,
} from '../../lib/storage-upload';

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
  /** What the client declared; the stored type is derived from it on every use. */
  contentType: string;
  fileName: string;
  fileSize: number;
  isPublic: boolean;
  userId: string;
  createdAt: number;
  /** Key carries a random segment: write it with an R2 create-only precondition. */
  createOnly?: boolean;
  /** Set by the PUT once the object is written; the token writes no second time. */
  uploaded?: boolean;
  uploadedAt?: number;
}

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
  // One token, one write. (KV is eventually consistent, so this flag is the
  // fast path; for keys with a random segment the R2 precondition below is the
  // atomic guard.)
  if (pending.uploaded) {
    return c.json({ error: 'Upload token already used' }, 409);
  }
  if (!c.env.STORAGE) {
    return c.json({ error: 'Storage is not configured' }, 500);
  }
  // Tokens minted before the cap existed may carry a larger declared size.
  if (pending.fileSize > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'File is too large' }, 413);
  }
  try {
    // The body must be exactly what the token was minted for.
    const body = await readBodyOfExactSize(c.req.raw, pending.fileSize);
    if (!body.ok) {
      return body.reason === 'too_large'
        ? c.json({ error: 'Upload is larger than the declared file size' }, 413)
        : c.json({ error: 'Upload size does not match the declared file size' }, 400);
    }

    // The type is the one declared at mint time, never the PUT's own header,
    // and only allowlisted types are stored as such.
    const stored = resolveStoredContent(pending.contentType);
    const result: R2Object | null = await c.env.STORAGE.put(pending.fileKey, body.bytes, {
      httpMetadata: {
        contentType: stored.contentType,
        ...(stored.contentDisposition ? { contentDisposition: stored.contentDisposition } : {}),
      },
      ...(pending.createOnly ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
    });
    if (!result) {
      // The create-only precondition failed: the key was already written.
      return c.json({ error: 'Upload token already used' }, 409);
    }
    await setPendingUpload(c.env.WORKSPACE_CACHE, token, {
      ...pending,
      uploaded: true,
      uploadedAt: Date.now(),
    });
    const etag = result.etag || '';
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
 * bucket — including private uploads (`PendingUpload.isPublic === false`) — in
 * any environment. We therefore FAIL CLOSED and serve only when
 * `ENVIRONMENT === 'development'`, i.e. exactly the local-dev case
 * `resolvePublicUrl` targets (it only ever hands out this worker URL for
 * localhost origins). In test/preview/production the route 404s and public
 * files are served by the mapped R2 domain instead. This mirrors the
 * `ENVIRONMENT !== 'production'` belt-and-braces gate used by `/test-fixtures/*`.
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

export const storageUploadTokenRoute = uploadTokenApp;

// ============================================================================
// Authenticated routes — generate + confirm
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
 */
app.post(
  '/generate-upload-url',
  // Beyond the shared schema: folder / entityType / entityId must be plain
  // path segments (they are interpolated into the R2 key and so into a public
  // URL), and fileSize has a hard cap. Hostile values are a 400.
  zValidator('json', generateUploadUrlRequestSchema),
  async (c) => {
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const workspaceId = c.get('workspaceId') || c.get('orgId');
    if (!workspaceId) return error.orgRequired(c);

    const data = c.req.valid('json');

    try {
      const uploadToken = generateUploadToken();
      const { fileKey, createOnly } = buildUploadKey(workspaceId, data);

      await setPendingUpload(c.env.WORKSPACE_CACHE, uploadToken, {
        fileKey,
        contentType: data.contentType,
        fileName: data.fileName,
        fileSize: data.fileSize,
        isPublic: data.isPublic,
        userId,
        createdAt: Date.now(),
        createOnly,
        uploaded: false,
      });

      const origin = new URL(c.req.url).origin;
      const uploadUrl = `${origin}/api/storage/upload/${uploadToken}`;

      return c.json({ success: true, uploadUrl, uploadToken, fileKey });
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

    if (!c.env.STORAGE) {
      return error.internal(c, 'Storage is not configured');
    }

    try {
      const head = await c.env.STORAGE.head(fileKey);
      if (!head) {
        return c.json({ success: false, error: 'File not found in storage' }, 400);
      }
      const publicUrl = resolvePublicUrl(c.req.url, c.env.R2_PUBLIC_URL, fileKey);
      const fileId = generateId('file');

      return c.json({
        success: true,
        file: {
          id: fileId,
          fileName: pending.fileName,
          fileKey,
          fileSize: head.size,
          // The type the object is stored and served as, not the raw claim.
          mimeType: resolveStoredContent(pending.contentType).contentType,
          url: publicUrl,
          isPublic: pending.isPublic,
        },
      });
    } catch (err) {
      console.error('[app-api/storage] confirm-upload failed:', err);
      return c.json({ success: false, error: 'Failed to confirm upload' }, 500);
    }
  },
);

export const storageRoutes = app;
