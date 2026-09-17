/**
 * Browser origins allowed to call app-api with credentials.
 *
 * Shared by both test (`app-api-test`) and production (`app-api`) workers —
 * there is no env-specific CORS list. Unlisted origins must return `null`
 * (deny), never a fallback host: echoing `https://app.weldsuite.org` for an
 * unmatched Origin is what broke the developer portal (browser rejects when
 * ACAO ≠ request Origin under credentials mode).
 */

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
