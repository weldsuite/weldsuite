import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') || '';
  const url = request.nextUrl.clone();
  
  // Extract subdomain by removing port and base domain
  let currentHost = hostname
    .replace(':3007', '')
    .replace(':3000', '')
    .replace(':3001', '')
    .replace(':3002', '')
    .replace(':3003', '')
    .replace(':3004', '')
    .replace(':3005', '')
    .replace(':3006', '');
  
  // Handle different environments
  const isLocalhost = currentHost.includes('localhost');
  const isProduction = currentHost.includes('weldsuite.org');
  
  let subdomain = '';

  if (isLocalhost) {
    // For localhost: subdomain.localhost:3007
    subdomain = currentHost.replace('.localhost', '').replace('localhost', '');

    // Default to test.weldcommerce.app for testing on localhost
    if (!subdomain) {
      subdomain = 'test.weldcommerce.app';
    }
  } else if (isProduction) {
    // For production: subdomain.weldsuite.org
    const parts = currentHost.split('.');
    if (parts.length >= 3 && parts[0]) {
      subdomain = parts[0]; // Extract subdomain
    }
  } else {
    // For custom domains
    subdomain = currentHost;
  }

  // If no subdomain or main domain, show home/management page
  if (!subdomain || subdomain === 'sites' || subdomain === 'www') {
    return NextResponse.rewrite(new URL('/home', request.url));
  }
  
  // Route to subdomain-specific content
  const searchParams = request.nextUrl.searchParams.toString();
  const path = `${request.nextUrl.pathname}${searchParams ? `?${searchParams}` : ''}`;
  
  // Rewrite to /[domain]/... path structure
  const rewritePath = `/${subdomain}${path === '/' ? '' : path}`;

  const response = NextResponse.rewrite(new URL(rewritePath, request.url));

  // Add security headers
  response.headers.set('X-DNS-Prefetch-Control', 'on');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  return response;
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.gif$|.*\\.svg$|.*\\.ico$).*)',
  ],
};