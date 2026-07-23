/**
 * WeldApps (user-created apps) service — pure logic shared by the
 * /api/user-apps management routes and the /public/user-apps asset host.
 *
 * Token contract (fixed): full token = 'wsat_' + 40 lowercase hex chars.
 * Only the SHA-256 hex digest is stored (userAppTokens.tokenHash);
 * tokenPrefix keeps the first 12 chars of the full token for display.
 */

import { and, eq, ne } from 'drizzle-orm';
import type { UserApp, UserAppManifest, UserAppVersion } from '@weldsuite/db/schema/master';
import { masterSchema, type MasterDatabase } from '../db';
import { generateId } from '../lib/id';

// ---------------------------------------------------------------------------
// Reserved codes — first-party modules share the sidenav/app-store namespace
// ---------------------------------------------------------------------------

export const RESERVED_APP_CODES: readonly string[] = [
  'weldcrm',
  'weldcommerce',
  'welddesk',
  'weldmail',
  'weldflow',
  'weldconnect',
  'weldstash',
  'weldhost',
  'weldbooks',
  'weldmeet',
  'weldchat',
  'weldagent',
  'weldapps',
  'appstore',
  'settings',
  'apps',
];

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MintedTokenParts {
  /** Plaintext token — returned to the caller exactly once. */
  token: string;
  /** SHA-256 hex digest stored in userAppTokens.tokenHash. */
  tokenHash: string;
  /** First 12 chars of the full token, for display. */
  tokenPrefix: string;
}

/** Generate a wsat_ token + its stored hash/prefix. Does NOT touch the DB. */
export async function mintTokenParts(): Promise<MintedTokenParts> {
  const token = `wsat_${randomHex(20)}`;
  return { token, tokenHash: await sha256Hex(token), tokenPrefix: token.slice(0, 12) };
}

// ---------------------------------------------------------------------------
// Scope algebra — wildcard-aware ('*' covers all, 'resource:*' covers
// 'resource:action'; exact strings otherwise)
// ---------------------------------------------------------------------------

function scopeCovers(granted: readonly string[], scope: string): boolean {
  if (granted.includes(scope) || granted.includes('*')) return true;
  const idx = scope.indexOf(':');
  if (idx > 0 && granted.includes(`${scope.slice(0, idx)}:*`)) return true;
  return false;
}

/** True when every requested scope is covered by the granted set. */
export function isScopeSuperset(granted: readonly string[], requested: readonly string[]): boolean {
  return requested.every((s) => scopeCovers(granted, s));
}

/** Requested scopes NOT covered by the granted set (order preserved, deduped). */
export function diffScopes(requested: readonly string[], granted: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of requested) {
    if (!scopeCovers(granted, s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Union of two scope lists (deduped, order preserved). */
export function unionScopes(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const s of b) if (!out.includes(s)) out.push(s);
  return out;
}

// ---------------------------------------------------------------------------
// Bundle content types + caching heuristics
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json',
};

export function contentTypeFor(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return CONTENT_TYPES[path.slice(dot + 1).toLowerCase()];
}

/** True when the final path segment has a file extension. */
export function hasFileExtension(path: string): boolean {
  const segment = path.split('/').pop() ?? '';
  return segment.includes('.');
}

/** Vite-style content-hashed filename (index-abc12345.js) → immutable cache. */
export function isHashedAsset(path: string): boolean {
  const segment = path.split('/').pop() ?? '';
  return /-[a-zA-Z0-9_]{8,}\./.test(segment);
}

/** Reject traversal / absolute / backslash paths in uploaded bundle entries. */
export function isSafeBundlePath(path: string): boolean {
  if (!path || path.length > 255) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return !path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

// ---------------------------------------------------------------------------
// Manifest → app column merging
// ---------------------------------------------------------------------------

/** App-table columns derived from a manifest when a version goes live. */
export function appFieldsFromManifest(manifest: UserAppManifest): Partial<typeof masterSchema.userApps.$inferInsert> {
  return {
    name: manifest.name,
    description: manifest.description ?? null,
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    ...(manifest.category ? { category: manifest.category } : {}),
    manifest,
    requestedScopes: manifest.scopes ?? [],
    pricingType: manifest.pricing?.type ?? 'free',
    priceMonthly:
      manifest.pricing?.type === 'subscription' && manifest.pricing.monthlyPrice != null
        ? String(manifest.pricing.monthlyPrice)
        : null,
    ...(manifest.pricing?.currency ? { currency: manifest.pricing.currency.toUpperCase() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Version publishing (shared by the upload route and review approval)
// ---------------------------------------------------------------------------

export interface InstallNeedingConsent {
  installId: string;
  workspaceId: string;
  pendingScopes: string[];
}

/**
 * Make `version` the live version of `app`:
 *  - previous published version → 'superseded'
 *  - version → 'published' (+publishedAt)
 *  - app.currentVersionId / manifest / requestedScopes / name / icon /
 *    category / description / pricing columns refreshed from the manifest
 *  - every ACTIVE install gets pendingScopes = new scopes not yet granted
 *    (token scopes are NOT expanded — re-consent gates them)
 *
 * Returns the installs whose pendingScopes were set so the caller can
 * mirror the owner-workspace tenant row.
 */
export async function publishAppVersion(
  master: MasterDatabase,
  app: UserApp,
  version: UserAppVersion,
): Promise<{ installsNeedingConsent: InstallNeedingConsent[] }> {
  const manifest = version.manifest;
  if (!manifest) throw new Error(`Version ${version.id} has no manifest`);
  const now = new Date();
  const { userApps, userAppVersions, userAppInstalls } = masterSchema;

  await master
    .update(userAppVersions)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(userAppVersions.appId, app.id),
        eq(userAppVersions.status, 'published'),
        ne(userAppVersions.id, version.id),
      ),
    );

  await master
    .update(userAppVersions)
    .set({ status: 'published', publishedAt: now })
    .where(eq(userAppVersions.id, version.id));

  await master
    .update(userApps)
    .set({ ...appFieldsFromManifest(manifest), currentVersionId: version.id, updatedAt: now })
    .where(eq(userApps.id, app.id));

  const requested = manifest.scopes ?? [];
  const installsNeedingConsent: InstallNeedingConsent[] = [];
  const activeInstalls = await master
    .select()
    .from(userAppInstalls)
    .where(and(eq(userAppInstalls.appId, app.id), eq(userAppInstalls.status, 'active')));

  for (const install of activeInstalls) {
    const newScopes = diffScopes(requested, install.grantedScopes ?? []);
    if (newScopes.length === 0) continue;
    await master
      .update(userAppInstalls)
      .set({ pendingScopes: newScopes, updatedAt: now })
      .where(eq(userAppInstalls.id, install.id));
    installsNeedingConsent.push({
      installId: install.id,
      workspaceId: install.workspaceId,
      pendingScopes: newScopes,
    });
  }

  return { installsNeedingConsent };
}

// ---------------------------------------------------------------------------
// Token minting (writes the master row, returns the plaintext once)
// ---------------------------------------------------------------------------

export const SESSION_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

export async function mintAppToken(
  master: MasterDatabase,
  params: {
    installId: string;
    appId: string;
    workspaceId: string;
    tokenType: 'install' | 'session';
    scopes: string[];
  },
): Promise<{ token: string; expiresAt: Date | null }> {
  const parts = await mintTokenParts();
  const expiresAt = params.tokenType === 'session' ? new Date(Date.now() + SESSION_TOKEN_TTL_MS) : null;
  await master.insert(masterSchema.userAppTokens).values({
    id: generateId('uat'),
    installId: params.installId,
    appId: params.appId,
    workspaceId: params.workspaceId,
    tokenHash: parts.tokenHash,
    tokenPrefix: parts.tokenPrefix,
    tokenType: params.tokenType,
    scopes: params.scopes,
    expiresAt,
  });
  return { token: parts.token, expiresAt };
}

// ---------------------------------------------------------------------------
// Public asset host — KV-cached code → bundle resolution
// ---------------------------------------------------------------------------

export interface ResolvedBundle {
  appId: string;
  bundleKey: string;
  entrypoint: string;
}

export const ASSET_CACHE_TTL_SECONDS = 60;

export function assetCacheKey(code: string): string {
  return `uapp-assets:${code}`;
}

/**
 * Resolve an app code to its live bundle, KV-cached for 60s.
 *
 * The bundle host is unauthenticated (iframes can't send headers), so this
 * is the distribution gate: a bundle is only servable when the app is
 * publicly approved OR has at least one active install (a private app's own
 * workspace installs it before the iframe ever loads). An uploaded-but-
 * never-installed private app is not fetchable. Bundles are still static
 * client-side assets — data access is guarded by wsat_ tokens, not by
 * bundle secrecy.
 */
export async function resolveBundleForCode(
  master: MasterDatabase,
  kv: KVNamespace,
  code: string,
): Promise<ResolvedBundle | null> {
  const cacheKey = assetCacheKey(code);
  const cached = (await kv.get(cacheKey, 'json')) as ResolvedBundle | null;
  if (cached) return cached;

  const { userApps, userAppVersions, userAppInstalls } = masterSchema;
  const [app] = await master
    .select({
      id: userApps.id,
      currentVersionId: userApps.currentVersionId,
      isActive: userApps.isActive,
      deletedAt: userApps.deletedAt,
      visibility: userApps.visibility,
      reviewStatus: userApps.reviewStatus,
    })
    .from(userApps)
    .where(eq(userApps.code, code))
    .limit(1);
  if (!app || !app.isActive || app.deletedAt || !app.currentVersionId) return null;

  const publiclyApproved = app.visibility === 'public' && app.reviewStatus === 'approved';
  if (!publiclyApproved) {
    const [install] = await master
      .select({ id: userAppInstalls.id })
      .from(userAppInstalls)
      .where(and(eq(userAppInstalls.appId, app.id), eq(userAppInstalls.status, 'active')))
      .limit(1);
    if (!install) return null;
  }

  const [version] = await master
    .select({ bundleKey: userAppVersions.bundleKey, entrypoint: userAppVersions.entrypoint })
    .from(userAppVersions)
    .where(eq(userAppVersions.id, app.currentVersionId))
    .limit(1);
  if (!version) return null;

  const resolved: ResolvedBundle = {
    appId: app.id,
    bundleKey: version.bundleKey,
    entrypoint: version.entrypoint,
  };
  await kv.put(cacheKey, JSON.stringify(resolved), { expirationTtl: ASSET_CACHE_TTL_SECONDS });
  return resolved;
}
