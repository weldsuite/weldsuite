import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Headers on every response the Worker renders (pages, server functions,
 * server routes; static assets are served before the Worker runs).
 *
 * The portal holds buttons that approve and sign off, so it must never be
 * framed (clickjacking). Everything it renders is one person's view of a
 * project, so no shared cache may keep it unless a route says otherwise.
 */
const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next()
  const { headers } = result.response
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store')
  return result
})

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders],
}))
