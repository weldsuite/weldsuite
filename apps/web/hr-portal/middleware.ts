import { NextRequest, NextResponse } from 'next/server';
import { appApiUrl } from '@/lib/api';

/**
 * Maps a custom domain (e.g. `team.acme.com`) to a workspace slug so
 * `/some/path` on that host resolves as `/<slug>/some/path` without the
 * visitor ever seeing the slug in the URL.
 *
 * `GET /public/hr-portal/resolve-host?host=<hostname>` on app-api holds the
 * mapping (written when a workspace saves its custom domain in WeldHR →
 * Workforce portal → Branding). This middleware calls it defensively: any
 * failure (network error, non-200, malformed body) just falls through and
 * lets the request continue unrewritten, so a backend hiccup never 500s the
 * portal on its own default hosts.
 */

const DEFAULT_HOSTS = (process.env.HR_PORTAL_DEFAULT_HOSTS || 'team.weldsuite.org,team-test.weldsuite.org,localhost:3022')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// Best-effort, per-instance cache. Edge runtimes recycle instances often, so
// this is purely to avoid a resolve-host round trip on every request within
// one instance's lifetime — never relied on for correctness.
const HOST_CACHE_TTL_MS = 5 * 60 * 1000;
const hostCache = new Map<string, { slug: string | null; expiresAt: number }>();

async function resolveSlugForHost(host: string): Promise<string | null> {
  const cached = hostCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.slug;

  try {
    const res = await fetch(`${appApiUrl()}/public/hr-portal/resolve-host?host=${encodeURIComponent(host)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      hostCache.set(host, { slug: null, expiresAt: Date.now() + HOST_CACHE_TTL_MS });
      return null;
    }
    const json = (await res.json().catch(() => null)) as { data?: { slug?: string } } | null;
    const slug = json?.data?.slug ?? null;
    hostCache.set(host, { slug, expiresAt: Date.now() + HOST_CACHE_TTL_MS });
    return slug;
  } catch {
    // Network error, timeout, etc. — never block the request on this.
    return null;
  }
}

export async function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || req.nextUrl.host).toLowerCase();
  if (DEFAULT_HOSTS.includes(host)) return NextResponse.next();

  const slug = await resolveSlugForHost(host);
  if (!slug) return NextResponse.next();

  const url = req.nextUrl.clone();
  // The app has no `/[workspace]` index page (employees and clients land on
  // different sub-paths), so a bare `/` on a custom domain goes to login.
  url.pathname = req.nextUrl.pathname === '/' ? `/${slug}/login` : `/${slug}${req.nextUrl.pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
};
