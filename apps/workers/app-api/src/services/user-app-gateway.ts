/**
 * WeldApps data gateway — lets the platform host make a community app's
 * external-api calls with the member's own Clerk session.
 *
 * The app iframe never holds a credential. The host (outside the sandbox)
 * calls `/api/user-apps/code/:code/gateway/v1/*` with the platform session it
 * already has; this module resolves the workspace's install grant, exchanges
 * it for a short-lived `wsat_` session token (cached server-side, never sent
 * to the browser) and forwards the request to external-api, which keeps
 * enforcing the install's granted scopes exactly as before.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { masterSchema, schema, type Database, type MasterDatabase } from '../db';
import type { Env } from '../types';
import { mintAppToken } from './user-apps';

const uApps = masterSchema.userApps;
const uInstalls = masterSchema.userAppInstalls;
const wsApps = schema.workspaceInstalledApps;

/** Refresh the cached token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** KV rejects expirationTtl below 60s. */
const MIN_KV_TTL_SECONDS = 60;
/** Upper bound on a forwarded request body. */
export const MAX_GATEWAY_BODY_BYTES = 25 * 1024 * 1024;

export const GATEWAY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Request headers the app may set; everything else (auth, cookies, …) is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'if-match',
  'if-none-match',
  'idempotency-key',
  'x-request-id',
];

/** Response headers passed back to the app. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'etag',
  'last-modified',
  'retry-after',
  'x-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
];

export interface ActiveInstall {
  appId: string;
  installId: string;
  grantedScopes: string[];
}

/**
 * The workspace's active install of `code`, or null. Requires the app to be
 * live in master, mirrored as installed in the tenant, and the master install
 * grant to be active — the same checks the session-token route has always
 * applied.
 */
export async function resolveActiveInstall(
  master: MasterDatabase,
  db: Database,
  workspaceId: string,
  code: string,
): Promise<ActiveInstall | null> {
  const [appRow] = await master
    .select({ id: uApps.id })
    .from(uApps)
    .where(and(eq(uApps.code, code), eq(uApps.isActive, true), isNull(uApps.deletedAt)))
    .limit(1);
  if (!appRow) return null;

  const [tenantRow] = await db
    .select({ id: wsApps.id })
    .from(wsApps)
    .where(
      and(
        eq(wsApps.appCode, code),
        eq(wsApps.appType, 'user'),
        eq(wsApps.isActive, true),
        isNull(wsApps.deletedAt),
      ),
    )
    .limit(1);
  if (!tenantRow) return null;

  const [install] = await master
    .select({ id: uInstalls.id, grantedScopes: uInstalls.grantedScopes })
    .from(uInstalls)
    .where(
      and(
        eq(uInstalls.appId, appRow.id),
        eq(uInstalls.workspaceId, workspaceId),
        eq(uInstalls.status, 'active'),
      ),
    )
    .limit(1);
  if (!install) return null;

  return { appId: appRow.id, installId: install.id, grantedScopes: install.grantedScopes ?? [] };
}

/**
 * Validate and normalise the external-api path the app asked for. Returns
 * null for anything that is not a plain `/v1/...` path (traversal, encoded
 * slashes, protocol-relative, backslashes).
 */
export function normalizeGatewayPath(rawPath: string): string | null {
  if (!rawPath.startsWith('/v1/')) return null;
  if (rawPath.includes('//') || rawPath.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('//')) return null;
  const segments = decoded.split('/');
  if (segments.some((s) => s === '..' || s === '.')) return null;
  // Encoded slashes would let one "segment" address a different route.
  if (/%2f/i.test(rawPath)) return null;
  return rawPath;
}

export function pickHeaders(source: Headers, allowed: readonly string[]): Headers {
  const out = new Headers();
  for (const name of allowed) {
    const value = source.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

export function pickRequestHeaders(source: Headers): Headers {
  return pickHeaders(source, FORWARDED_REQUEST_HEADERS);
}

export function pickResponseHeaders(source: Headers): Headers {
  return pickHeaders(source, FORWARDED_RESPONSE_HEADERS);
}

// ---------------------------------------------------------------------------
// Server-side session-token cache
// ---------------------------------------------------------------------------

interface CachedGatewayToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Per-isolate cache in front of KV. */
const isolateCache = new Map<string, CachedGatewayToken>();

function cacheKey(workspaceId: string, code: string): string {
  return `uagw:v1:${workspaceId}:${code}`;
}

function isFresh(entry: CachedGatewayToken | null | undefined, now: number): entry is CachedGatewayToken {
  return !!entry && entry.expiresAt - TOKEN_REFRESH_MARGIN_MS > now;
}

export async function dropGatewayToken(env: Env, workspaceId: string, code: string): Promise<void> {
  const key = cacheKey(workspaceId, code);
  isolateCache.delete(key);
  try {
    await env.WORKSPACE_CACHE.delete(key);
  } catch (err) {
    console.error('[app-api/user-app-gateway] cache delete failed:', err);
  }
}

/**
 * A valid `wsat_` session token for the workspace's install of `code`.
 * Isolate cache → KV → mint. Returns null when the app is not (or no longer)
 * installed.
 */
export async function getGatewayToken(
  env: Env,
  master: MasterDatabase,
  db: Database,
  workspaceId: string,
  code: string,
): Promise<string | null> {
  const key = cacheKey(workspaceId, code);
  const now = Date.now();

  const local = isolateCache.get(key);
  if (isFresh(local, now)) return local.token;

  try {
    const shared = await env.WORKSPACE_CACHE.get<CachedGatewayToken>(key, 'json');
    if (isFresh(shared, now)) {
      isolateCache.set(key, shared);
      return shared.token;
    }
  } catch (err) {
    console.error('[app-api/user-app-gateway] cache read failed:', err);
  }

  const install = await resolveActiveInstall(master, db, workspaceId, code);
  if (!install) return null;

  const minted = await mintAppToken(master, {
    installId: install.installId,
    appId: install.appId,
    workspaceId,
    tokenType: 'session',
    scopes: install.grantedScopes,
  });
  const entry: CachedGatewayToken = {
    token: minted.token,
    expiresAt: minted.expiresAt ? minted.expiresAt.getTime() : now + TOKEN_REFRESH_MARGIN_MS * 2,
  };
  isolateCache.set(key, entry);

  const ttlSeconds = Math.floor((entry.expiresAt - TOKEN_REFRESH_MARGIN_MS - now) / 1000);
  if (ttlSeconds >= MIN_KV_TTL_SECONDS) {
    try {
      await env.WORKSPACE_CACHE.put(key, JSON.stringify(entry), { expirationTtl: ttlSeconds });
    } catch (err) {
      console.error('[app-api/user-app-gateway] cache write failed:', err);
    }
  }
  return entry.token;
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

function externalApiBase(env: Env): string {
  return (env.EXTERNAL_API_URL || 'https://api.weldsuite.org').replace(/\/+$/, '');
}

/**
 * Send one request to external-api. Prefers the EXTERNAL_API service
 * binding (a same-zone route cannot be reached with a plain fetch from a
 * Worker); falls back to the public URL for local setups without it.
 */
export async function forwardToExternalApi(
  env: Env,
  params: {
    method: string;
    pathAndQuery: string;
    headers: Headers;
    body: ArrayBuffer | null;
    token: string;
  },
): Promise<Response> {
  const headers = new Headers(params.headers);
  headers.set('Authorization', `Bearer ${params.token}`);
  const request = new Request(`${externalApiBase(env)}${params.pathAndQuery}`, {
    method: params.method,
    headers,
    body: params.body,
  });
  return env.EXTERNAL_API ? env.EXTERNAL_API.fetch(request) : fetch(request);
}
