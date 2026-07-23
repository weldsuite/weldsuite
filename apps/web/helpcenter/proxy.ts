import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const hostname = request.headers.get('host') || '';
  const url = request.nextUrl.clone();

  // Strip port for local dev
  let currentHost = hostname.replace(':3008', '');

  const isLocalhost = currentHost.includes('localhost');
  const isWelddesk = currentHost.includes('welddesk.org');

  let domain = '';

  if (isLocalhost) {
    // Local dev: subdomain.localhost:3008
    const subdomain = currentHost.replace('.localhost', '').replace('localhost', '');
    domain = subdomain ? `${subdomain}.welddesk.org` : 'test.welddesk.org';
  } else if (isWelddesk) {
    // Production: *.welddesk.org — use full hostname
    domain = currentHost;
  } else {
    // Custom domain: help.acme.com
    domain = currentHost;
  }

  if (!domain) {
    return NextResponse.rewrite(new URL('/not-found', request.url));
  }

  // Rewrite to /[domain]/... route structure
  const searchParams = request.nextUrl.searchParams.toString();
  const path = `${request.nextUrl.pathname}${searchParams ? `?${searchParams}` : ''}`;
  const rewritePath = `/${domain}${path === '/' ? '' : path}`;

  const response = NextResponse.rewrite(new URL(rewritePath, request.url));

  // Security headers
  response.headers.set('X-DNS-Prefetch-Control', 'on');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('Referrer-Policy', 'origin-when-cross-origin');

  return response;
}

export const config = {
  matcher: [
    // robots.txt / sitemap.xml are intentionally NOT excluded: their handlers
    // live under app/[domain]/, so the request must be rewritten to the
    // domain-namespaced route to resolve (otherwise they 404 at root).
    '/((?!api|_next/static|_next/image|favicon.ico|icon.svg|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.ico$).*)',
  ],
};
