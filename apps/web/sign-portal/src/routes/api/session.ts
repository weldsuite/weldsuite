import { createFileRoute } from '@tanstack/react-router'
import { signerPortal } from '@/lib/server/signer-portal'
import { sessionResponse } from '@/lib/server/session'

/** Opens a signing link: exchanges the link token for a signer session cookie. */
export const Route = createFileRoute('/api/session')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const input = (await request.json().catch(() => ({}))) as { token?: unknown }
        const token = String(input.token ?? '')
        return sessionResponse(request, token, await signerPortal().openSession(request, { token }))
      },
    },
  },
})
