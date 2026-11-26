import { createFileRoute } from '@tanstack/react-router'
import { pendingCookie, redirectOf } from '@weldsuite/sign-domain/portal-callback'
import { noStore, SIGN_LINK_HEADER, sessionFor } from '@/lib/server/portal'
import { signerPortal } from '@/lib/server/signer-portal'

const notFound = () => Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })

/**
 * The signer-session calls: browser code calls `/api/portal/<path>` on this
 * origin with the `x-sign-link` header, and the session comes from that
 * link's httpOnly cookie, so the token never reaches browser JavaScript.
 *
 *   GET  envelope | documents/<id> | download | evidence
 *   POST consent | complete | decline
 *   POST signature/start | signature/cancel   (advanced and qualified signatures)
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
        if (path === 'evidence') return noStore(await portal.evidence(request, session))
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
          case 'signature/start': {
            const res = await portal.signatureStart(request, session, input)
            const next = await redirectOf(res)
            const token = request.headers.get(SIGN_LINK_HEADER)
            if (!next?.state || !token) return noStore(res)
            // The provider sends the browser back without the link: remember which link and state this is.
            const out = noStore(Response.json({ data: { redirectUrl: next.redirectUrl } }))
            out.headers.append('Set-Cookie', pendingCookie({ token, state: next.state }, new URL(request.url).protocol === 'https:'))
            return out
          }
          case 'signature/cancel':
            return noStore(await portal.signatureCancel(request, session, input))
          default:
            return notFound()
        }
      },
    },
  },
})
