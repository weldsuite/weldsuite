import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Security headers on every response the Worker renders (pages, server
 * functions, server routes). Static assets are served before the Worker runs
 * and don't get them, as with the old `proxy.ts` matcher.
 */
const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next()
  const { headers } = result.response
  headers.set('X-DNS-Prefetch-Control', 'on')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'SAMEORIGIN')
  headers.set('Referrer-Policy', 'origin-when-cross-origin')
  return result
})

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders],
}))
