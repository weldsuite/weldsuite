import { createFileRoute } from '@tanstack/react-router'
import { portal, portalContext } from '@/lib/server/portal'

/** Emails a fresh code for the link token. */
export const Route = createFileRoute('/api/resend-code')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const input = (await request.json().catch(() => ({}))) as { token?: unknown }
        return portal.resendCode(portalContext(request), { token: String(input.token ?? '') })
      },
    },
  },
})
