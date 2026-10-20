/**
 * WeldApps bundle access.
 *
 * The /public/user-apps host is unauthenticated, and an iframe `src` can carry
 * neither a bearer token nor (third-party cookies are blocked) a session. So a
 * bundle that is not public + approved is only served behind a short-lived
 * signed capability carried in the URL path:
 *
 *   /public/user-apps/:code/s/<exp>.<workspace>.<sig>/<asset path>
 *
 * - `exp` is the expiry in epoch seconds.
 * - `workspace` is base64url(workspaceId) of the workspace the link was minted
 *   for.
 * - `sig` is base64url(HMAC-SHA256(key, "uapp-bundle/v1\n<appId>\n<workspaceId>\n<exp>")).
 *   The app id is NOT in the link: the server derives it from `:code`, so a link
 *   minted for one app can never open another.
 *
 * Bundles reference their assets relatively (`./assets/…`, lazy chunks via
 * `import()`), so the token survives every asset load made from the document.
 *
 * Minting (`POST /api/user-apps/code/:code/bundle-url`) needs a Clerk session of
 * a member of the authoring workspace or of a workspace that has the app
 * installed. Serving re-checks that access (KV-cached for 60s), so an uninstall
 * ends access within a minute even though the link itself lives for 12 hours.
 *
 * Also here: the optional dedicated bundle origin and the response headers the
 * bundle host sets. See docs/plans/weldapps-native-surfaces.md and the
 * "separate bundle origin" notes in routes/public-user-apps.
 */

import { and, eq } from 'drizzle-orm';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Bindings read by the bundle host. Declared here (and merged into `Env` by
 * {@link bundleEnv}) so the bundle host owns its own configuration surface.
 */
export interface BundleAccessEnv {
  /**
   * Origin that serves bundles, e.g. `https://weldappcontent.net`, or a
   * per-app template `https://{code}.weldappcontent.net`. Unset keeps the
   * bundles on the API origin. When set, the bundle host answers only on that
   * origin and the API host stops serving bundles.
   */
  USER_APP_BUNDLE_ORIGIN?: string;
  /**
   * Signing secret of bundle links. Optional: falls back to a key derived
   * (HKDF, distinct label) from INTERNAL_API_SECRET. Generate with
   * `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   */
  USER_APP_BUNDLE_SIGNING_KEY?: string;
  /** Extra `frame-ancestors` sources (space or comma separated), beyond the first-party platform origins. */
  USER_APP_FRAME_ANCESTORS?: string;
}

export type BundleEnv = Env & BundleAccessEnv;

/** View the worker env as the bundle host's env. */
export function bundleEnv(env: Env): BundleEnv {
  return env as BundleEnv;
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.codePointAt(i) ?? 0;
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signed capability links
// ---------------------------------------------------------------------------

/**
 * How long a link stays valid. Frames are kept alive by WeldAppFrameLayer, so a
 * lazy chunk can load hours after the document did; the host re-mints on
 * remount and when a hidden frame nears expiry.
 */
export const BUNDLE_LINK_TTL_SECONDS = 12 * 60 * 60;

const HKDF_SALT = 'weldsuite-user-app-bundle';
const HKDF_INFO = 'weldsuite/app-api/user-app-bundle-capability/v1';
const SIGNED_PREFIX = 'uapp-bundle/v1';

/** `<exp>.<base64url(workspaceId)>.<sig>`; the signature is a 32 byte HMAC. */
const TOKEN_PATTERN = /^(\d{1,12})\.([A-Za-z0-9_-]{1,96})\.([A-Za-z0-9_-]{43})$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `segment` has the shape of a bundle link token. */
export function looksLikeBundleToken(segment: string): boolean {
  return TOKEN_PATTERN.test(segment);
}

function signingMaterial(env: BundleAccessEnv & { INTERNAL_API_SECRET?: string }): string | null {
  const dedicated = env.USER_APP_BUNDLE_SIGNING_KEY?.trim();
  if (dedicated) return dedicated;
  return env.INTERNAL_API_SECRET?.trim() || null;
}

let cachedKey: { material: string; key: Promise<CryptoKey> } | null = null;

async function deriveSigningKey(material: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(HKDF_SALT), info: encoder.encode(HKDF_INFO) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/** The link signing key, or null when no secret is configured (links fail closed). */
async function getSigningKey(env: BundleEnv): Promise<CryptoKey | null> {
  const material = signingMaterial(env);
  if (!material) return null;
  if (cachedKey?.material !== material) {
    cachedKey = { material, key: deriveSigningKey(material) };
  }
  return cachedKey.key;
}

function signedData(appId: string, workspaceId: string, exp: number): Uint8Array {
  return encoder.encode(`${SIGNED_PREFIX}\n${appId}\n${workspaceId}\n${exp}`);
}

export interface MintedBundleLink {
  token: string;
  expiresAt: Date;
}

/** Sign a link for `workspaceId`'s access to `appId`. Null when no signing secret is configured. */
export async function signBundleCapability(
  env: BundleEnv,
  params: { appId: string; workspaceId: string; ttlSeconds?: number; nowMs?: number },
): Promise<MintedBundleLink | null> {
  if (!WORKSPACE_ID_PATTERN.test(params.workspaceId)) return null;
  const key = await getSigningKey(env);
  if (!key) return null;
  const now = params.nowMs ?? Date.now();
  const exp = Math.floor(now / 1000) + (params.ttlSeconds ?? BUNDLE_LINK_TTL_SECONDS);
  const signature = await crypto.subtle.sign('HMAC', key, signedData(params.appId, params.workspaceId, exp));
  const token = `${exp}.${toBase64Url(encoder.encode(params.workspaceId))}.${toBase64Url(new Uint8Array(signature))}`;
  return { token, expiresAt: new Date(exp * 1000) };
}

export type BundleCapabilityVerdict =
  | { ok: true; workspaceId: string; expiresAt: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'unconfigured' };

/**
 * Check a link for `appId`. `expired` is only reported for an authentic link
 * (signature first), so the response never tells a guesser anything.
 */
export async function verifyBundleCapability(
  env: BundleEnv,
  params: { appId: string; token: string; nowMs?: number },
): Promise<BundleCapabilityVerdict> {
  const match = TOKEN_PATTERN.exec(params.token);
  if (!match) return { ok: false, reason: 'malformed' };
  const exp = Number(match[1]);
  const workspaceBytes = fromBase64Url(match[2] ?? '');
  const signature = fromBase64Url(match[3] ?? '');
  if (!workspaceBytes || !signature || !Number.isSafeInteger(exp)) return { ok: false, reason: 'malformed' };
  const workspaceId = new TextDecoder().decode(workspaceBytes);
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) return { ok: false, reason: 'malformed' };

  const key = await getSigningKey(env);
  if (!key) return { ok: false, reason: 'unconfigured' };

  // crypto.subtle.verify compares in constant time.
  const authentic = await crypto.subtle.verify('HMAC', key, signature, signedData(params.appId, workspaceId, exp));
  if (!authentic) return { ok: false, reason: 'bad_signature' };

  const now = params.nowMs ?? Date.now();
  if (exp * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, workspaceId, expiresAt: exp * 1000 };
}

// ---------------------------------------------------------------------------
// Who may open a non-public bundle
// ---------------------------------------------------------------------------

const ACCESS_CACHE_TTL_SECONDS = 60;

export function bundleAccessCacheKey(appId: string, workspaceId: string): string {
  return `uapp-access:v1:${appId}:${workspaceId}`;
}

/**
 * The authoring workspace, or a workspace with an ACTIVE install of the app.
 * Always reads the database; the minting route uses this directly.
 */
export async function workspaceMayUseBundle(
  master: MasterDatabase,
  params: { appId: string; ownerWorkspaceId: string; workspaceId: string },
): Promise<boolean> {
  if (params.ownerWorkspaceId === params.workspaceId) return true;
  const { userAppInstalls } = masterSchema;
  const [install] = await master
    .select({ id: userAppInstalls.id })
    .from(userAppInstalls)
    .where(
      and(
        eq(userAppInstalls.appId, params.appId),
        eq(userAppInstalls.workspaceId, params.workspaceId),
        eq(userAppInstalls.status, 'active'),
      ),
    )
    .limit(1);
  return Boolean(install);
}

/**
 * {@link workspaceMayUseBundle} for the serving path: a bundle load is dozens of
 * requests, so the verdict is cached in KV for 60s (an uninstall or delete
 * drops it at once via {@link invalidateBundleAccess}).
 */
export async function workspaceMayUseBundleCached(
  master: MasterDatabase,
  kv: KVNamespace,
  params: { appId: string; workspaceId: string },
): Promise<boolean> {
  const key = bundleAccessCacheKey(params.appId, params.workspaceId);
  try {
    const cached = await kv.get(key);
    if (cached === '1') return true;
    if (cached === '0') return false;
  } catch (err) {
    console.error('[app-api/user-apps-bundle-access] cache read failed:', err);
  }

  const { userApps } = masterSchema;
  const [app] = await master
    .select({ ownerWorkspaceId: userApps.ownerWorkspaceId })
    .from(userApps)
    .where(eq(userApps.id, params.appId))
    .limit(1);
  const allowed = app
    ? await workspaceMayUseBundle(master, {
        appId: params.appId,
        ownerWorkspaceId: app.ownerWorkspaceId,
        workspaceId: params.workspaceId,
      })
    : false;

  try {
    await kv.put(key, allowed ? '1' : '0', { expirationTtl: ACCESS_CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('[app-api/user-apps-bundle-access] cache write failed:', err);
  }
  return allowed;
}

/** Drop the cached verdict after an install, uninstall or delete. */
export async function invalidateBundleAccess(kv: KVNamespace, appId: string, workspaceId: string): Promise<void> {
  try {
    await kv.delete(bundleAccessCacheKey(appId, workspaceId));
  } catch (err) {
    console.error('[app-api/user-apps-bundle-access] cache invalidation failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The unsigned bundle path of a public, approved app. */
export function plainBundlePath(code: string, file = 'index.html'): string {
  return `/public/user-apps/${encodeURIComponent(code)}/${file}`;
}

/** The signed bundle path of a non-public app. */
export function signedBundlePath(code: string, token: string, file = 'index.html'): string {
  return `/public/user-apps/${encodeURIComponent(code)}/s/${token}/${file}`;
}

export interface SplitBundlePath {
  /** The link token when the path starts with `s/<token>/`, else null. */
  token: string | null;
  /** The asset path inside the bundle ('' for the entrypoint). */
  assetPath: string;
}

/**
 * Split the part of the request path after `/public/user-apps/:code/` into the
 * optional link token and the asset path. A leading `s/` segment that is not a
 * well-formed token stays part of the asset path, so a bundle may have its own
 * `s/` folder.
 */
export function splitBundlePath(rest: string): SplitBundlePath {
  if (rest.startsWith('s/')) {
    const afterPrefix = rest.slice(2);
    const slash = afterPrefix.indexOf('/');
    const segment = slash === -1 ? afterPrefix : afterPrefix.slice(0, slash);
    if (looksLikeBundleToken(segment)) {
      return { token: segment, assetPath: slash === -1 ? '' : afterPrefix.slice(slash + 1) };
    }
  }
  return { token: null, assetPath: rest };
}

// ---------------------------------------------------------------------------
// Bundle origin
// ---------------------------------------------------------------------------

export type BundleOriginResolution =
  | { status: 'unset' }
  | { status: 'invalid' }
  | { status: 'ok'; origin: string; perApp: boolean };

/**
 * The origin that must serve `code`'s bundle. `unset` keeps today's behaviour
 * (bundles on the API origin); `invalid` is a configured-but-unusable value and
 * must fail closed rather than silently fall back.
 */
export function resolveBundleOrigin(env: BundleAccessEnv, code: string): BundleOriginResolution {
  const raw = env.USER_APP_BUNDLE_ORIGIN?.trim();
  if (!raw) return { status: 'unset' };
  const perApp = raw.includes('{code}');
  let url: URL;
  try {
    url = new URL(raw.replaceAll('{code}', code));
  } catch {
    return { status: 'invalid' };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (!secure || !bare) return { status: 'invalid' };
  return { status: 'ok', origin: url.origin, perApp };
}

/** Whether a request on `requestOrigin` may be served `code`'s bundle. */
export function isBundleHostRequest(env: BundleAccessEnv, code: string, requestOrigin: string): boolean {
  const resolution = resolveBundleOrigin(env, code);
  if (resolution.status === 'unset') return true;
  return resolution.status === 'ok' && resolution.origin === requestOrigin;
}

/**
 * Whether a request on `requestOrigin` is on the dedicated bundle host (any
 * app). False when no bundle origin is configured. The API host uses it to stop
 * serving anything but bundles there (see `bundleHostGuard`).
 */
export function isDedicatedBundleOrigin(env: BundleAccessEnv, requestOrigin: string): boolean {
  const raw = env.USER_APP_BUNDLE_ORIGIN?.trim();
  if (!raw) return false;
  if (!raw.includes('{code}')) {
    const resolution = resolveBundleOrigin(env, 'x');
    return resolution.status === 'ok' && resolution.origin === requestOrigin;
  }
  // Per-app template: the code is the leftmost label of the host.
  let host: URL;
  try {
    host = new URL(requestOrigin);
  } catch {
    return false;
  }
  const label = host.hostname.split('.')[0] ?? '';
  if (!label) return false;
  const resolution = resolveBundleOrigin(env, label);
  return resolution.status === 'ok' && resolution.origin === requestOrigin;
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

/** First-party origins that may embed a bundle (the platform SPA, test and local dev). */
const FRAME_ANCESTOR_ORIGINS: readonly string[] = [
  'https://app.weldsuite.org',
  'https://app-test.weldsuite.org',
  'https://app-preview.weldsuite.org',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
];

const FRAME_ANCESTOR_SOURCE = /^https?:\/\/(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

/**
 * `frame-ancestors` directive of every bundle response: the platform origins
 * (plus `USER_APP_FRAME_ANCESTORS`), never `*`, so a bundle cannot be framed by
 * an arbitrary site.
 */
export function bundleFrameAncestors(env: BundleAccessEnv): string {
  const extra = (env.USER_APP_FRAME_ANCESTORS ?? '')
    .split(/[\s,]+/)
    .map((source) => source.trim())
    .filter((source) => source && FRAME_ANCESTOR_SOURCE.test(source));
  return `frame-ancestors ${[...new Set([...FRAME_ANCESTOR_ORIGINS, ...extra])].join(' ')}`;
}

/** True for the fetch a browser makes to register a service worker script. */
export function isServiceWorkerScriptRequest(headers: Headers): boolean {
  return headers.get('service-worker') === 'script';
}
