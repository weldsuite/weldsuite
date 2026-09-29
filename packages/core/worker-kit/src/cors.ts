/**
 * CORS for API workers.
 *
 * One origin list for every API worker and every environment. Unlisted
 * origins must return `null` (deny), never a fallback host: echoing
 * `https://app.weldsuite.org` for an unmatched Origin is what broke the
 * developer portal (browser rejects when ACAO ≠ request Origin under
 * credentials mode).
 */

import { cors } from 'hono/cors';

const FIRST_PARTY_ORIGINS = [
  'https://app.weldsuite.org',
  'https://app-test.weldsuite.org',
  'https://app-preview.weldsuite.org',
  'https://developer.weldsuite.org',
  'https://developer-test.weldsuite.org',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:3202',
] as const;

/** Resolve the Access-Control-Allow-Origin value for a request Origin header. */
export function resolveCorsOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (/\.welddesk\.org$/.test(origin)) return origin;
  if ((FIRST_PARTY_ORIGINS as readonly string[]).includes(origin)) return origin;
  return null;
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
    ],
    exposeHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: CORS_MAX_AGE_SECONDS,
  });
