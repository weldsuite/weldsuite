import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Headers on every response the Worker renders (pages, server functions,
 * server routes; static assets are served before the Worker runs).
 *
 * A form page is meant to be framed by the sites that embed it, so framing is
 * decided per form: the form's loader sets `frame-ancestors` from its allowed
 * embed domains (lib/page-data.ts). Every other response (the landing page,
 * /api/*, 404s) may not be framed. What a respondent sees is theirs alone, so
 * no shared cache may keep it unless a route says otherwise.
 */
const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next()
  const { headers } = result.response
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', "frame-ancestors 'none'")
    headers.set('X-Frame-Options', 'DENY')
  }
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store')
  return result
})

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders],
}))
