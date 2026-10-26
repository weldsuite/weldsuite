import { createFileRoute } from '@tanstack/react-router'
import { noStore, portal, portalContext, sessionFor } from '@/lib/server/portal'

const notFound = () => Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })

/**
 * The signer-session calls: browser code calls `/api/portal/<path>` on this
 * origin with the `x-sign-link` header, and the session comes from that
 * link's httpOnly cookie, so the token never reaches browser JavaScript.
 *
 *   GET  envelope | documents/<id> | download
 *   POST consent | complete | decline
 */
export const Route = createFileRoute('/api/portal/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ctx = portalContext(request)
        const session = await sessionFor(request)
        const path = params._splat ?? ''
        const document = /^documents\/([^/]+)$/.exec(path)
        if (document) return noStore(await portal.document(ctx, session, decodeURIComponent(document[1]!)))
        if (path === 'envelope') return noStore(await portal.envelope(ctx, session))
        if (path === 'download') return noStore(await portal.download(ctx, session))
        return notFound()
      },
      POST: async ({ request, params }) => {
        const ctx = portalContext(request)
        const session = await sessionFor(request)
        const input: unknown = await request.json().catch(() => undefined)
        switch (params._splat) {
          case 'consent':
            return noStore(await portal.consent(ctx, session, input))
          case 'complete':
            return noStore(await portal.complete(ctx, session, input))
          case 'decline':
            return noStore(await portal.decline(ctx, session, input))
          default:
            return notFound()
        }
      },
    },
  },
})
