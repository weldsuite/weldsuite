import { createFileRoute } from '@tanstack/react-router'
import { handleSignatureCallback } from '@weldsuite/sign-domain/portal-callback'
import { sessionForToken } from '@/lib/server/portal'
import { signerPortal } from '@/lib/server/signer-portal'

/**
 * Where the trust service provider sends the signer back to, a fixed URL it
 * has registered: `/signature-callback?code=…&state=…` (or `?error=…`). The
 * link token is not in it, so the `state` is matched against the cookie the
 * round trip started with (`signature/start`); the rest is
 * `@weldsuite/sign-domain/portal-callback`. Always a redirect: to the provider
 * again for a second step, or to the signer's own link page.
 */
export const Route = createFileRoute('/signature-callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const portal = signerPortal()
        const result = await handleSignatureCallback(new URL(request.url), request.headers.get('cookie'), {
          sessionFor: (token) => sessionForToken(request, token),
          finish: (session, input) => portal.signatureFinish(request, session, input),
          cancel: (session, input) => portal.signatureCancel(request, session, input),
        })
        return new Response(null, {
          status: 302,
          headers: { Location: result.location, 'Set-Cookie': result.setCookie, 'Cache-Control': 'private, no-store' },
        })
      },
    },
  },
})
