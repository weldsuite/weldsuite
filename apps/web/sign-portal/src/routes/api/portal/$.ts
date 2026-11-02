import { createFileRoute } from '@tanstack/react-router'
import { noStore, sessionFor } from '@/lib/server/portal'
import { signerPortal } from '@/lib/server/signer-portal'

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
        const portal = signerPortal()
        const session = await sessionFor(request)
        const path = params._splat ?? ''
        const document = /^documents\/([^/]+)$/.exec(path)
        if (document) return noStore(await portal.document(request, session, decodeURIComponent(document[1]!)))
        if (path === 'envelope') return noStore(await portal.envelope(request, session))
        if (path === 'download') return noStore(await portal.download(request, session))
        return notFound()
      },
      POST: async ({ request, params }) => {
        const portal = signerPortal()
        const session = await sessionFor(request)
        const input: unknown = await request.json().catch(() => undefined)
        switch (params._splat) {
          case 'consent':
            return noStore(await portal.consent(request, session, input))
          case 'complete':
            return noStore(await portal.complete(request, session, input))
          case 'decline':
            return noStore(await portal.decline(request, session, input))
          default:
            return notFound()
        }
      },
    },
  },
})
