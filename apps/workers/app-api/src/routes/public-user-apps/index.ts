/**
 * Public WeldApps bundle host — /public/user-apps/:code/* surface.
 *
 * UNAUTHENTICATED. Mounted OUTSIDE the /api/* Clerk guard. Serves the live
 * (currentVersionId) R2 bundle of a user-created app so the platform can
 * iframe it at /apps/{code}. The code → bundle resolution is KV-cached for
 * 60s (invalidated on publish); assets themselves are static R2 objects.
 *
 * Who may read a bundle:
 *   - a public, approved app: anyone, at the plain URL
 *       /public/user-apps/:code/<asset>
 *   - every other app (private, unreviewed, rejected): only behind a signed,
 *     workspace-bound link in the path, minted by an authenticated member of
 *     the authoring workspace or of a workspace that has the app installed
 *       /public/user-apps/:code/s/<link>/<asset>
 *     (services/user-apps-bundle-access.ts). Without a valid link the answer is
 *     the same 404 as for an unknown app.
 *
 * Responses MUST NOT set X-Frame-Options. They carry `frame-ancestors` for the
 * platform origins only (not `*`), `nosniff`, and `Access-Control-Allow-Origin:
 * *` so sandboxed iframes (Origin: null) and Vite `crossorigin` module scripts
 * can load sibling CSS/JS. Service worker registration is refused.
 *
 * Bundle origin: with USER_APP_BUNDLE_ORIGIN set, bundles are served only on
 * that origin and this router answers 404 on every other host (the API host
 * included). Unset, bundles stay on the API origin. The API routes must in turn
 * not answer on the bundle host: see `bundleHostRejection` below.
 */

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../../types';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import {
  contentTypeFor,
  hasFileExtension,
  isHashedAsset,
  resolveBundleForCode,
} from '../../services/user-apps';
import {
  bundleEnv,
  bundleFrameAncestors,
  type BundleEnv,
  isBundleHostRequest,
  isDedicatedBundleOrigin,
  isServiceWorkerScriptRequest,
  splitBundlePath,
  verifyBundleCapability,
  workspaceMayUseBundleCached,
} from '../../services/user-apps-bundle-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** Upper bound of the browser cache of a gated asset (never beyond the link's life). */
const MAX_PRIVATE_CACHE_SECONDS = 24 * 60 * 60;

type BundleContext = Context<{ Bindings: Env; Variables: Variables }>;

function jsonError(status: 403 | 404 | 500, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const notFound = (message: string) => jsonError(404, 'NOT_FOUND', message);

/**
 * With a dedicated bundle origin configured, the bundle host answers nothing but
 * bundles (the other direction, bundles refused off the bundle host, is in
 * `serveAsset`). Returns the 404 for a request that must not reach the API
 * routes, or null to carry on. No-op without USER_APP_BUNDLE_ORIGIN.
 *
 * It has to run before the module forwarder, which is the first middleware
 * `createModuleApi` installs (so a Hono `app.use` added in index.ts comes too
 * late for forwarded module paths). Wrap the worker's fetch handler in index.ts:
 *
 *   fetch: (request, env, ctx) => bundleHostRejection(request, env) ?? app.fetch(request, env, ctx),
 *
 * A Workers *route* restricted to `<bundle host>/public/user-apps/*` (instead of
 * a custom domain) makes the same guarantee at the edge.
 */
export function bundleHostRejection(request: Request, env: Env): Response | null {
  const bundle = bundleEnv(env);
  if (!bundle.USER_APP_BUNDLE_ORIGIN?.trim()) return null;
  const url = new URL(request.url);
  if (isDedicatedBundleOrigin(bundle, url.origin) && !url.pathname.startsWith('/public/user-apps/')) {
    return notFound('Not found');
  }
  return null;
}

/** `bundleHostRejection` as Hono middleware, for tests and routers mounted after the forwarder. */
export const bundleHostGuard: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) =>
  bundleHostRejection(c.req.raw, c.env) ?? next();

/** Headers every bundle response carries; gated (signed) responses are private. */
function bundleHeaders(
  env: BundleEnv,
  params: { contentType: string; etag: string; servePath: string; gatedUntilMs: number | null },
): Headers {
  const headers = new Headers();
  headers.set('Content-Type', params.contentType);
  headers.set('ETag', params.etag);
  // Iframe embedding is the point, but only by the platform: no X-Frame-Options,
  // no `frame-ancestors *`.
  headers.set('Content-Security-Policy', bundleFrameAncestors(env));
  headers.set('X-Content-Type-Options', 'nosniff');
  // Opaque-origin sandboxes (and Vite `crossorigin` module scripts) fetch
  // sibling assets with Origin: null — allow CORS so CSS/JS are not blocked.
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

  if (params.gatedUntilMs === null) {
    headers.set('Cache-Control', isHashedAsset(params.servePath) ? IMMUTABLE_CACHE : 'no-cache');
  } else {
    // The URL carries a capability: keep it out of shared caches, never let the
    // browser keep an asset past the link's expiry, and send only the origin
    // (never the token) as Referer to other sites.
    const remaining = Math.max(0, Math.floor((params.gatedUntilMs - Date.now()) / 1000));
    headers.set(
      'Cache-Control',
      isHashedAsset(params.servePath)
        ? `private, max-age=${Math.min(remaining, MAX_PRIVATE_CACHE_SECONDS)}`
        : 'private, no-cache',
    );
    headers.set('Referrer-Policy', 'strict-origin');
  }
  return headers;
}

async function serveAsset(c: BundleContext, code: string, rest: string): Promise<Response> {
  const env = bundleEnv(c.env);
  if (!c.env.STORAGE) return jsonError(500, 'INTERNAL_ERROR', 'Storage is not configured');

  // A service worker registered from a bundle would persist on this origin and
  // intercept later loads; refuse the script fetch so registration fails.
  if (isServiceWorkerScriptRequest(c.req.raw.headers)) {
    return jsonError(403, 'FORBIDDEN', 'Service workers are not available for WeldApps');
  }

  if (!isBundleHostRequest(env, code, new URL(c.req.url).origin)) return notFound(`App '${code}' not found`);

  const { token, assetPath } = splitBundlePath(rest);

  // Path traversal guard — bundle keys are flat prefixes under user-apps/.
  if (assetPath.split('/').includes('..')) return notFound('Asset not found');

  const master = getMasterDb(c.env);
  const bundle = await resolveBundleForCode(master, c.env.WORKSPACE_CACHE, code);
  if (!bundle) return notFound(`App '${code}' not found`);

  let gatedUntilMs: number | null = null;
  if (bundle.requiresToken !== false) {
    // Not public: needs a link for this app, still valid, whose workspace still
    // has access. Anything else looks exactly like an unknown app.
    if (!token) return notFound(`App '${code}' not found`);
    const verdict = await verifyBundleCapability(env, { appId: bundle.appId, token });
    if (!verdict.ok) {
      if (verdict.reason === 'expired') {
        return jsonError(403, 'BUNDLE_LINK_EXPIRED', 'This app link has expired. Reload the app.');
      }
      if (verdict.reason === 'unconfigured') {
        console.error('[app-api/public-user-apps] no bundle signing secret configured; refusing a gated bundle');
      }
      return notFound(`App '${code}' not found`);
    }
    const allowed = await workspaceMayUseBundleCached(master, c.env.WORKSPACE_CACHE, {
      appId: bundle.appId,
      workspaceId: verdict.workspaceId,
    });
    if (!allowed) return notFound(`App '${code}' not found`);
    gatedUntilMs = verdict.expiresAt;
  }

  // SPA fallback: no path or an extension-less path serves the entrypoint.
  const servePath = assetPath && hasFileExtension(assetPath) ? assetPath : bundle.entrypoint;
  const obj = await c.env.STORAGE.get(`${bundle.bundleKey}/${servePath}`);
  if (!obj) return notFound('Asset not found');

  const headers = bundleHeaders(env, {
    contentType: obj.httpMetadata?.contentType ?? contentTypeFor(servePath) ?? 'application/octet-stream',
    etag: obj.httpEtag,
    servePath,
    gatedUntilMs,
  });
  return new Response(obj.body, { status: 200, headers });
}

async function handle(c: BundleContext, code: string, rest: string): Promise<Response> {
  try {
    return await serveAsset(c, code, rest);
  } catch (err) {
    console.error('[app-api/public-user-apps] serve failed:', err);
    return jsonError(500, 'INTERNAL_ERROR', 'Failed to serve app asset');
  }
}

app.get('/:code', (c) => handle(c, c.req.param('code'), ''));

app.get('/:code/*', async (c) => {
  const code = c.req.param('code');
  // Everything after "/:code/" relative to this router's mount point.
  const prefix = `/public/user-apps/${code}/`;
  const raw = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
  let rest: string;
  try {
    rest = decodeURIComponent(raw);
  } catch {
    return notFound('Asset not found');
  }
  return handle(c, code, rest);
});

export const publicUserAppsRoutes = app;
