import { createFileRoute } from '@tanstack/react-router'
import { signerPortal } from '@/lib/server/signer-portal'

/** Emails a fresh code for the link token. */
export const Route = createFileRoute('/api/resend-code')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const input = (await request.json().catch(() => ({}))) as { token?: unknown }
        return signerPortal().resendCode(request, { token: String(input.token ?? '') })
      },
    },
  },
})
