import { createMiddleware, createStart } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { authRequestMiddleware } from '@/lib/auth-middleware';
import { isSameSiteRequest } from '@/lib/same-site';

/**
 * Headers on every response the Worker renders (pages, server functions,
 * server routes; static assets are served before the Worker runs). The console
 * changes plans, credits and workspaces, so it must never be framed, and every
 * page is one admin's view, so no shared cache may keep it.
 */
const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next();
  const { headers } = result.response;
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store');
  return result;
});

/**
 * Server functions that change something are POSTs from this console's own
 * pages. Next checked the Origin of server actions itself; TanStack Start
 * doesn't, so a cross-site POST (a forged form, CSRF) is refused here before
 * any action runs. The Clerk session cookie is SameSite=Lax as well.
 */
const sameSiteMutations = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const request = getRequest();
  if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameSiteRequest(request)) {
    throw new Error('Cross-site request refused');
  }
  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, ...authRequestMiddleware],
  functionMiddleware: [sameSiteMutations],
}));
