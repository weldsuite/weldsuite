import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Security headers on every response the Worker renders. The signing page
 * must never be framed (a hidden "Sign" button is the classic clickjacking
 * target), and no response may leak the link in a Referer.
 */
const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next()
  const { headers } = result.response
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  headers.set('Referrer-Policy', 'no-referrer')
  return result
})

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders],
}))
