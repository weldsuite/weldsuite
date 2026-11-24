/**
 * What happens to every request before a route sees it (src/start.ts):
 *
 * 1. Only the storefront edge gets an answer (`X-Storefront-Edge`); a 404 otherwise.
 * 2. `/__preview?token=…` sets the preview cookie and sends the editor's iframe to `/`.
 * 3. The site's own redirects (`document.redirects`) answer with a 301; a host
 *    without a published site gets a plain 404.
 * 4. Writes come from the shop's own pages (CSRF; the cookies are SameSite=Lax too).
 * 5. Security headers go on what the app answers.
 */

import { createCsrfMiddleware, createMiddleware } from '@tanstack/react-start'
import { COOKIE, previewCookie, serializeCookie } from '../cookies'
import { EDGE_HEADER, isEdgeSecret, isOpenPath, refusal } from '../edge-auth'
import { edgeVersion, isHttps, shopHost } from '../forwarded'
import { redirectTarget } from '../redirects'
import { rendererSecret } from './config'
import { previewToken } from './shop'
import { loadSite, SiteUnavailableError } from './site'

export const edgeOnly = createMiddleware().server(async ({ request, next }) => {
  const { pathname } = new URL(request.url)
  if (isOpenPath(pathname)) return next()
  if (!(await isEdgeSecret(request.headers.get(EDGE_HEADER), rendererSecret()))) return refusal()
  return next()
})

export const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next()
  const { headers } = result.response
  headers.set('X-Content-Type-Options', 'nosniff')
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  // Pages carry the shopper's cart and account; no shared cache keeps them unless a route says so.
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store')
  return result
})

/** The longest preview token taken (the backend signs short ones). */
const MAX_TOKEN = 4_096

export const previewEntry = createMiddleware().server(({ request, next }) => {
  const url = new URL(request.url)
  if (url.pathname !== '/__preview') return next()
  const token = url.searchParams.get('token') ?? ''
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  if (token && token.length <= MAX_TOKEN) {
    headers.append('Set-Cookie', serializeCookie(COOKIE.preview, token, previewCookie(isHttps(request.headers), shopHost(request.headers))))
  }
  return new Response(null, { status: 302, headers })
})

const unavailable = () =>
  new Response('<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found</p>', {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })

export const documentRedirects = createMiddleware().server(async ({ request, next }) => {
  const url = new URL(request.url)
  if ((request.method !== 'GET' && request.method !== 'HEAD') || url.pathname.startsWith('/_serverFn') || isOpenPath(url.pathname)) return next()
  let site
  try {
    site = await loadSite({ host: shopHost(request.headers), previewToken: previewToken(request), versionHint: edgeVersion(request.headers) })
  } catch (error) {
    if (error instanceof SiteUnavailableError && error.status === 404) return unavailable()
    // The server is down: let the page fail with its own error.
    return next()
  }
  const target = redirectTarget(site.version.document.redirects, url)
  if (target) return new Response(null, { status: 301, headers: { Location: target, 'Cache-Control': 'public, max-age=300' } })
  return next()
})

/**
 * Writes come from the shop's own pages: `Sec-Fetch-Site: same-origin`, or
 * an `Origin` on the shop host (the renderer sits behind the edge, so the
 * request URL's own origin is not the shop's).
 */
export const csrf = createCsrfMiddleware({
  filter: ({ request }) => request.method !== 'GET' && request.method !== 'HEAD',
  origin: (origin, { request }) => {
    try {
      return new URL(origin).hostname.toLowerCase() === shopHost(request.headers)
    } catch {
      return false
    }
  },
})
