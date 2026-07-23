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
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  generateUploadUrlSchema,
  confirmUploadSchema,
} from '@weldsuite/core-api-client/schemas/storage';
import type { Env, Variables } from '../../types';
import { error } from '../../lib/response';
import { generateId } from '../../lib/id';

// ============================================================================
// KV-stored upload tokens (10 min TTL).
// ============================================================================

const UPLOAD_TOKEN_PREFIX = 'upload:';
const UPLOAD_TOKEN_TTL = 600;

interface PendingUpload {
  fileKey: string;
  contentType: string;
  fileName: string;
  fileSize: number;
  isPublic: boolean;
  userId: string;
  createdAt: number;
}

async function setPendingUpload(kv: KVNamespace, token: string, data: PendingUpload) {
  await kv.put(`${UPLOAD_TOKEN_PREFIX}${token}`, JSON.stringify(data), {
    expirationTtl: UPLOAD_TOKEN_TTL,
  });
}

async function getPendingUpload(kv: KVNamespace, token: string): Promise<PendingUpload | null> {
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
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
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
  if (!c.env.STORAGE) {
    return c.json({ error: 'Storage is not configured' }, 500);
  }
  try {
    const body = await c.req.arrayBuffer();
    const result = await c.env.STORAGE.put(pending.fileKey, body, {
      httpMetadata: { contentType: pending.contentType },
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
 * bucket — including private uploads (`PendingUpload.isPublic === false`) — in
 * any environment. We therefore FAIL CLOSED and serve only when
 * `ENVIRONMENT === 'development'`, i.e. exactly the local-dev case
 * `resolvePublicUrl` targets (it only ever hands out this worker URL for
 * localhost origins). In test/preview/production the route 404s and public
 * files are served by the mapped R2 domain instead. This mirrors the
 * `ENVIRONMENT !== 'production'` belt-and-braces gate used by `/test-fixtures/*`.
 */
uploadTokenApp.get('/api/storage/public/*', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
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
  zValidator('json', generateUploadUrlSchema),
  async (c) => {
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const workspaceId = c.get('workspaceId') || c.get('orgId');
    if (!workspaceId) return error.orgRequired(c);

    const data = c.req.valid('json');

    try {
      const uploadToken = generateId('upl');
      let fileKey: string;

      if (data.entityType === 'customer-avatar' && data.entityId) {
        const ext = data.fileName.split('.').pop()?.toLowerCase() || 'png';
        fileKey = `workspaces/${workspaceId}/avatars/customers/${data.entityId}/logo.${ext}`;
      } else if (data.entityType === 'contact-avatar' && data.entityId) {
        const ext = data.fileName.split('.').pop()?.toLowerCase() || 'png';
        fileKey = `workspaces/${workspaceId}/avatars/contacts/${data.entityId}/logo.${ext}`;
      } else {
        const timestamp = Date.now();
        const sanitizedName = data.fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const folder = data.folder || 'uploads';
        const entityPath =
          data.entityType && data.entityId ? `${data.entityType}/${data.entityId}` : 'general';
        fileKey = `workspaces/${workspaceId}/${folder}/${entityPath}/${timestamp}_${sanitizedName}`;
      }

      await setPendingUpload(c.env.WORKSPACE_CACHE, uploadToken, {
        fileKey,
        contentType: data.contentType,
        fileName: data.fileName,
        fileSize: data.fileSize,
        isPublic: data.isPublic,
        userId,
        createdAt: Date.now(),
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

    const { uploadToken, fileKey } = c.req.valid('json');

    const pending = await getPendingUpload(c.env.WORKSPACE_CACHE, uploadToken);
    if (!pending) {
      return c.json({ success: false, error: 'Invalid or expired upload token' }, 400);
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
          mimeType: pending.contentType,
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
