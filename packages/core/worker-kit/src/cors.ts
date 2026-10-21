/**
 * CORS for API workers, and the matching Clerk authorized-party (`azp`) check.
 *
 * One origin list for every API worker and every environment. Unlisted
 * origins must return `null` (deny), never a fallback host: echoing
 * `https://app.weldsuite.org` for an unmatched Origin is what broke the
 * developer portal (browser rejects when ACAO ≠ request Origin under
 * credentials mode).
 *
 * The same list is the allow-list for the `azp` claim of Clerk session tokens
 * (`isAuthorizedParty`, used by `middleware/clerk.ts`), so the origins a
 * browser may call from and the origins whose tokens we accept cannot drift.
 *
 * Only exact, company-controlled origins belong here. Never add a wildcard or
 * a suffix match: hostnames such as `{slug}.welddesk.org` are chosen by
 * tenants (2026-09-22 audit, finding 649). The help center on those hosts
 * renders on the server and calls app-api from there, so no browser on a
 * `welddesk.org` host needs CORS (or credentials) on an API worker.
 */

import { cors } from 'hono/cors';

export const FIRST_PARTY_ORIGINS = [
  'https://app.weldsuite.org',
  'https://app-test.weldsuite.org',
  'https://app-preview.weldsuite.org',
  'https://developer.weldsuite.org',
  'https://developer-test.weldsuite.org',
  'https://partner.weldsuite.org',
  'https://partner-test.weldsuite.org',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:3202',
  'http://localhost:3203',
] as const;

const FIRST_PARTY_SET: ReadonlySet<string> = new Set(FIRST_PARTY_ORIGINS);

/** Resolve the Access-Control-Allow-Origin value for a request Origin header. */
export function resolveCorsOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  return FIRST_PARTY_SET.has(origin) ? origin : null;
}

/**
 * One concrete origin: scheme + host (+ port), nothing else. No wildcards, no
 * path. `chrome-extension://` is for the WeldPass browser extension, whose
 * origin is its extension id (32 letters a-p).
 */
const EXACT_ORIGIN = /^(?:https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?|chrome-extension:\/\/[a-p]{32})$/;

/**
 * Parse the optional `CLERK_AUTHORIZED_PARTIES` worker var: a comma- or
 * whitespace-separated list of extra origins whose Clerk tokens are accepted on
 * top of `FIRST_PARTY_ORIGINS` (the WeldPass extension's
 * `chrome-extension://<id>`, a new frontend before it ships in code). It adds
 * to the `azp` allow-list only, never to CORS. Entries that are not an exact
 * origin are dropped, so a wildcard or a URL with a path cannot widen the list.
 */
let lastExtraRaw: string | undefined;
let lastExtraParsed: readonly string[] = [];

export function parseExtraAuthorizedParties(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  if (raw === lastExtraRaw) return lastExtraParsed;
  const parsed = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => EXACT_ORIGIN.test(entry));
  lastExtraRaw = raw;
  lastExtraParsed = parsed;
  return parsed;
}

/**
 * Whether a verified Clerk token may be used here, judged by its `azp` claim.
 *
 * Browser sessions carry the page origin as `azp`, so a token minted for any
 * other frontend on the same Clerk instance (a customer-influenced host, a
 * look-alike app) is refused. A token with NO `azp` is accepted: native
 * clients (the Expo apps) send no Origin header when they mint a token, so
 * Clerk leaves the claim out, and `@clerk/backend` itself skips the check in
 * that case. A claim that is present but empty or not a string is refused.
 */
export function isAuthorizedParty(azp: unknown, extraOrigins: readonly string[] = []): boolean {
  if (azp === undefined || azp === null) return true;
  if (typeof azp !== 'string' || azp === '') return false;
  return FIRST_PARTY_SET.has(azp) || extraOrigins.includes(azp);
}

/**
 * Preflight results are cached for a day. With one API host per module a
 * page talks to several origins, and each origin pays its own preflights.
 */
export const CORS_MAX_AGE_SECONDS = 86_400;

export const apiCors = () =>
  cors({
    origin: (origin) => resolveCorsOrigin(origin),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Test-Token / X-Test-Flags are the test-only seams (gated by env +
    // token in their respective middleware, inert in production). Allowing the
    // header NAMES here just lets a browser-driven E2E send them cross-origin;
    // it grants nothing on its own.
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Test-Token',
      'X-Test-Flags',
      'X-Accounting-Entity-Id',
      'X-Weld-App',
      // Partner portal: which partner the caller acts for, and retry-safe credit grants.
      'X-Partner-Id',
      'Idempotency-Key',
    ],
    // Retry-After: a browser client reads it off a 503 WORKSPACE_MOVING to know
    // how long to back off while a workspace's database is being moved.
    exposeHeaders: ['X-Request-Id', 'X-Partner-Warnings', 'Retry-After'],
    credentials: true,
    maxAge: CORS_MAX_AGE_SECONDS,
  });
