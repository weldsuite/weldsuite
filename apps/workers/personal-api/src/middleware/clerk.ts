/**
 * Clerk JWT verification — adapted from app-api (user only; org ignored).
 * Also resolves Clerk Billing entitlements from session claims.
 *
 * `@clerk/backend` `verifyToken` is tried first. If that throws (stale PEM,
 * escaped newlines in wrangler secrets, JWKS fetch on Workers), fall back to
 * the same Web Crypto RS256 check billing-worker uses so a production Expo
 * session JWT still authenticates.
 *
 * Whichever path verified the token, its authorized party (`azp`) is checked
 * afterwards against `PERSONAL_AUTHORIZED_PARTIES`, so a session token minted
 * for another frontend on the same Clerk instance is refused. The check sits
 * outside the verify-then-fall-back chain on purpose: a refusal inside
 * `verifyToken` would only send the token on to the Web Crypto fallback, which
 * checks the signature alone. Expo apps mint tokens with no `azp` and pass.
 */

import { createMiddleware } from 'hono/factory';
import { verifyToken } from '@clerk/backend';
import { entitlementsFromClerkClaims, FREE_ENTITLEMENTS } from '../lib/billing';
import type { Env, Variables } from '../types';

type ClerkJwtPayload = {
  sub?: string;
  sid?: string;
  exp?: number;
  azp?: unknown;
  [key: string]: unknown;
};

/**
 * Browser origins that sign personal accounts in and call this API: the
 * consumer WeldCalendar web app (apps/web/weldcalendar) and the local dev
 * servers of WeldMail web (3200) and WeldCalendar web (3201). personal-api is
 * outside @weldsuite/worker-kit, so this is its own list rather than the
 * kit's FIRST_PARTY_ORIGINS (the platform, developer and partner portals do
 * not call personal-api).
 *
 * The consumer WeldMail web app's custom host is not recorded in the repo (its
 * API is api.weldmail.com, the app ships to the Pages projects `weldmail-web`
 * and `weldmail-web-test`), so it is matched by isWeldmailWebOrigin below:
 * https on weldmail.com or one subdomain label of it, or a deployment of one
 * of those two Pages projects. All of these hosts are WeldSuite's own (users
 * claim addresses on weldmail.com, never subdomains). Anything else goes in
 * the `CLERK_AUTHORIZED_PARTIES` worker var (comma-separated origins).
 */
export const PERSONAL_AUTHORIZED_PARTIES = [
  'https://weldcalendar.weldsuite.org',
  'https://weldcalendar-test.weldsuite.org',
  'http://localhost:3200',
  'http://localhost:3201',
] as const;

/** Hosts WeldMail web runs on; one extra subdomain label is allowed on each. */
const WELDMAIL_WEB_HOSTS = ['weldmail.com', 'weldmail-web.pages.dev', 'weldmail-web-test.pages.dev'] as const;
const HTTPS_HOST_ORIGIN = /^https:\/\/([a-z0-9.-]+)$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** https on a WeldMail web host or one subdomain label of it (no port, no path). */
function isWeldmailWebOrigin(origin: string): boolean {
  const host = HTTPS_HOST_ORIGIN.exec(origin)?.[1];
  if (!host) return false;
  return WELDMAIL_WEB_HOSTS.some((base) => {
    if (host === base) return true;
    if (!host.endsWith(`.${base}`)) return false;
    return DNS_LABEL.test(host.slice(0, -(base.length + 1)));
  });
}

/** One concrete origin: scheme and host (+ port); no wildcard, no path. */
const EXACT_ORIGIN =
  /^(?:https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?|chrome-extension:\/\/[a-p]{32})$/;

/** The extra origins configured in the `CLERK_AUTHORIZED_PARTIES` var. */
export function parseExtraAuthorizedParties(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => EXACT_ORIGIN.test(entry));
}

/**
 * Whether a verified token's `azp` claim names an origin allowed to use this
 * API. No claim passes (native clients send no Origin, so Clerk omits it); a
 * claim that is present but empty or not a string does not.
 */
export function isAuthorizedParty(azp: unknown, extraOrigins: readonly string[] = []): boolean {
  if (azp === undefined || azp === null) return true;
  if (typeof azp !== 'string' || azp === '') return false;
  return (
    (PERSONAL_AUTHORIZED_PARTIES as readonly string[]).includes(azp) ||
    isWeldmailWebOrigin(azp) ||
    extraOrigins.includes(azp)
  );
}

function formatClerkError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { reason?: string; message?: string; action?: string };
    const parts = [e.reason, e.message, e.action].filter(Boolean);
    if (parts.length > 0) return parts.join(' — ');
  }
  return err instanceof Error ? err.message : String(err);
}

function normalizePem(key: string): string {
  return key.replaceAll(String.raw`\n`, '\n').replaceAll(String.raw`\r`, '').trim();
}

function decodeJwtPayload(token: string): ClerkJwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const json = atob(parts[1].replaceAll('-', '+').replaceAll('_', '/'));
  return JSON.parse(json) as ClerkJwtPayload;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = normalizePem(pem)
    .replaceAll('-----BEGIN PUBLIC KEY-----', '')
    .replaceAll('-----END PUBLIC KEY-----', '')
    .replaceAll(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i)!;
  }
  return bytes.buffer;
}

function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i)!;
  }
  return bytes.buffer;
}

/** Networkless RS256 verify — same approach as billing-worker. */
async function verifyClerkJwtLocal(token: string, pemKey: string): Promise<ClerkJwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const header = JSON.parse(atob(parts[0].replaceAll('-', '+').replaceAll('_', '/'))) as { alg?: string };
  if (header.alg !== 'RS256') throw new Error(`Unsupported algorithm: ${header.alg}`);

  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(pemKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    base64UrlToArrayBuffer(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error('Invalid JWT signature');

  const payload = decodeJwtPayload(token);
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}

async function verifyClerkToken(token: string, env: Env): Promise<ClerkJwtPayload> {
  const secretKey = env.CLERK_SECRET_KEY;
  const jwtKey = env.CLERK_JWT_KEY ? normalizePem(env.CLERK_JWT_KEY) : undefined;
  const options = { secretKey, clockSkewInMs: 60_000 };

  if (jwtKey) {
    try {
      return (await verifyToken(token, { ...options, jwtKey })) as ClerkJwtPayload;
    } catch (err) {
      console.error('[personal-api] jwtKey verifyToken failed:', formatClerkError(err));
    }
  }

  try {
    return (await verifyToken(token, options)) as ClerkJwtPayload;
  } catch (err) {
    console.error('[personal-api] JWKS verifyToken failed:', formatClerkError(err));
    if (!jwtKey) throw err;
    return verifyClerkJwtLocal(token, jwtKey);
  }
}

export const clerkMiddleware = () => {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } },
        401,
      );
    }

    const token = authHeader.slice(7);

    try {
      const payload = await verifyClerkToken(token, c.env);

      if (!payload.sub) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token payload' } }, 401);
      }

      const extraParties = parseExtraAuthorizedParties(
        (c.env as Env & { CLERK_AUTHORIZED_PARTIES?: string }).CLERK_AUTHORIZED_PARTIES,
      );
      if (!isAuthorizedParty(payload.azp, extraParties)) {
        // The origin only, never the token. Truncated: the claim is client-influenced.
        console.warn(
          `[personal-api] token refused, azp ${JSON.stringify(payload.azp).slice(0, 200)} is not an authorized party`,
        );
        c.set('entitlements', FREE_ENTITLEMENTS);
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } }, 401);
      }

      c.set('userId', payload.sub);
      c.set('sessionId', (payload.sid as string | undefined) || '');
      c.set(
        'entitlements',
        entitlementsFromClerkClaims(payload as Record<string, unknown>),
      );

      await next();
    } catch (err) {
      console.error('Clerk auth error:', formatClerkError(err));
      c.set('entitlements', FREE_ENTITLEMENTS);
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } }, 401);
    }
  });
};
