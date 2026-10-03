/**
 * Public link of a booking page.
 *
 * Guests book through the public booking portal (`apps/web/booking-portal`,
 * route `/[workspace]/[slug]`), never through the platform: the platform
 * origin redirects anonymous visitors to the login screen. So the link must
 * never be built from `window.location.origin`.
 */

/** Production booking portal. */
export const DEFAULT_BOOKING_PORTAL_URL = 'https://book.weldsuite.org';

/** Test-environment booking portal (`*-test.weldsuite.org` convention). */
export const TEST_BOOKING_PORTAL_URL = 'https://book-test.weldsuite.org';

/** `next dev --port 3019` in `apps/web/booking-portal`. */
export const LOCAL_BOOKING_PORTAL_URL = 'http://localhost:3019';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Platform hosts that have a matching test booking portal. */
const TEST_PLATFORM_HOSTS = new Set(['app-test.weldsuite.org']);

const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, '');

/**
 * Pure resolver: a configured URL wins, otherwise the portal is derived from
 * the host the platform is served from. Unknown hosts (Pages previews, custom
 * domains) fall back to the production portal, never to the SPA origin.
 */
export function resolveBookingPortalUrl(
  configured: string | null | undefined,
  hostname: string | null | undefined,
): string {
  const explicit = configured?.trim();
  if (explicit) return stripTrailingSlashes(explicit);

  const host = hostname?.trim().toLowerCase() ?? '';
  if (LOCAL_HOSTS.has(host)) return LOCAL_BOOKING_PORTAL_URL;
  if (TEST_PLATFORM_HOSTS.has(host)) return TEST_BOOKING_PORTAL_URL;
  return DEFAULT_BOOKING_PORTAL_URL;
}

/** Booking portal origin for the current environment (no trailing slash). */
export function getBookingPortalUrl(): string {
  const configured = import.meta.env.VITE_BOOKING_PORTAL_URL as string | undefined;
  const hostname = typeof window === 'undefined' ? undefined : window.location.hostname;
  return resolveBookingPortalUrl(configured, hostname);
}

/** Full public link of a booking page: `<portal>/<workspace-slug>/<page-slug>`. */
export function buildBookingPageUrl(workspaceSlug: string, pageSlug: string): string {
  return `${getBookingPortalUrl()}/${workspaceSlug}/${pageSlug}`;
}
