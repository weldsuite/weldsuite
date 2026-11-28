import { createFileRoute } from '@tanstack/react-router'
import { getPdf } from '@/lib/server/backend'

/** The HTTP status for a failed backend lookup. */
function failureStatus(reason: string): number {
  if (reason === 'not_found') return 404
  if (reason === 'rate_limited') return 429
  return 502
}

/**
 * The PDF of a link's document, streamed from the backend so the browser never
 * learns where the backend is. `$token_` keeps it out of the page's layout.
 */
export const Route = createFileRoute('/d/$token_/pdf')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const pdf = await getPdf(params.token)
        if (!pdf.ok) {
          return new Response(null, { status: failureStatus(pdf.reason), headers: { 'Cache-Control': 'no-store' } })
        }
        return new Response(pdf.response.body, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="document.pdf"',
            'Cache-Control': 'private, no-store',
          },
        })
      },
    },
  },
})
