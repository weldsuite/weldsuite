import { createFileRoute } from '@tanstack/react-router'
import { signerPortal } from '@/lib/server/signer-portal'
import { sessionResponse } from '@/lib/server/session'

/** Checks the emailed code or access code; on success sets the signer session cookie. */
export const Route = createFileRoute('/api/verify')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const input = (await request.json().catch(() => ({}))) as { token?: unknown; code?: unknown }
        const token = String(input.token ?? '')
        const code = String(input.code ?? '')
        return sessionResponse(request, token, await signerPortal().verify(request, { token, code }))
      },
    },
  },
})
