import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Headers on every response the app renders (pages, server functions, server
 * routes). The link's token is the only credential, so no response may leak it
 * in a Referer, be framed, be kept by a cache or end up in a search index. The
 * Content-Security-Policy carries a per-response nonce, so node/server.mjs adds
 * it (node/security.mjs).
 */
const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next()
  const { headers } = result.response
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()')
  headers.set('Cache-Control', 'private, no-store')
  return result
})

/** Writes come from this app's own pages: `Sec-Fetch-Site: same-origin`, or an `Origin` that is the request's own. */
const csrf = createCsrfMiddleware({
  filter: ({ request }) => request.method !== 'GET' && request.method !== 'HEAD',
})

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, csrf],
}))
