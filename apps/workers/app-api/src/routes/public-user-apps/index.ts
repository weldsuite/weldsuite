/**
 * Public WeldApps bundle host — /public/user-apps/:code/* surface.
 *
 * UNAUTHENTICATED. Mounted OUTSIDE the /api/* Clerk guard. Serves the live
 * (currentVersionId) R2 bundle of a user-created app so the platform can
 * iframe it at /apps/{code}. The code → bundle resolution is KV-cached for
 * 60s (invalidated on publish); assets themselves are static R2 objects.
 *
 * Responses deliberately carry `Content-Security-Policy: frame-ancestors *`
 * and MUST NOT set X-Frame-Options — the whole point is to be iframed.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { getMasterDb } from '../../db';
import {
  contentTypeFor,
  hasFileExtension,
  isHashedAsset,
  resolveBundleForCode,
} from '../../services/user-apps';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function jsonNotFound(message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message } }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function serveAsset(env: Env, code: string, assetPath: string): Promise<Response> {
  if (!env.STORAGE) {
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Storage is not configured' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Path traversal guard — bundle keys are flat prefixes under user-apps/.
  if (assetPath.split('/').some((seg) => seg === '..')) {
    return jsonNotFound('Asset not found');
  }

  const master = getMasterDb(env);
  const bundle = await resolveBundleForCode(master, env.WORKSPACE_CACHE, code);
  if (!bundle) return jsonNotFound(`App '${code}' not found`);

  // SPA fallback: no path or an extension-less path serves the entrypoint.
  const servePath = assetPath && hasFileExtension(assetPath) ? assetPath : bundle.entrypoint;
  const obj = await env.STORAGE.get(`${bundle.bundleKey}/${servePath}`);
  if (!obj) return jsonNotFound('Asset not found');

  const headers = new Headers();
  headers.set(
    'Content-Type',
    obj.httpMetadata?.contentType ?? contentTypeFor(servePath) ?? 'application/octet-stream',
  );
  headers.set('Cache-Control', isHashedAsset(servePath) ? IMMUTABLE_CACHE : 'no-cache');
  // Iframe-embedding is the point — allow any ancestor, never X-Frame-Options.
  headers.set('Content-Security-Policy', 'frame-ancestors *');
  headers.set('ETag', obj.httpEtag);
  return new Response(obj.body, { status: 200, headers });
}

app.get('/:code', async (c) => {
  const code = c.req.param('code');
  try {
    return await serveAsset(c.env, code, '');
  } catch (err) {
    console.error('[app-api/public-user-apps] serve failed:', err);
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Failed to serve app asset' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});

app.get('/:code/*', async (c) => {
  const code = c.req.param('code');
  // Everything after "/:code/" relative to this router's mount point.
  const prefix = `/public/user-apps/${code}/`;
  const raw = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(raw);
  } catch {
    return jsonNotFound('Asset not found');
  }
  try {
    return await serveAsset(c.env, code, assetPath);
  } catch (err) {
    console.error('[app-api/public-user-apps] serve failed:', err);
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Failed to serve app asset' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});

export const publicUserAppsRoutes = app;
